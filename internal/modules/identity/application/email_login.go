package application

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
	"coolto.local/cv-agent-app-be/internal/platform/id"
)

type EmailLoginConfig struct {
	HashKey         string
	TTL             time.Duration
	ResendAfter     time.Duration
	MaxAttempts     int
	RateWindow      time.Duration
	EmailSendLimit  int
	DeviceSendLimit int
	IPSendLimit     int
	VerifyLimit     int
}

type ChallengeRequest struct {
	ChallengeID string
	Email       string
	Device      DeviceInput
	RemoteIP    string
}

type ChallengeAccepted struct {
	ChallengeID       string
	ExpiresAt         time.Time
	RetryAfterSeconds int
}

type VerifyRequest struct {
	ChallengeID string
	Code        string
	Device      DeviceInput
	RemoteIP    string
}

// EmailLoginService coordinates challenge persistence, delivery and login.
type EmailLoginService struct {
	challenges  ChallengeRepository
	sender      EmailSender
	limiter     RateLimiter
	issuer      *SessionIssuer
	provisioner Provisioner
	cfg         EmailLoginConfig
	now         Clock
}

func NewEmailLoginService(
	challenges ChallengeRepository, sender EmailSender, limiter RateLimiter,
	issuer *SessionIssuer, provisioner Provisioner, cfg EmailLoginConfig, now Clock,
) *EmailLoginService {
	return &EmailLoginService{challenges: challenges, sender: sender, limiter: limiter,
		issuer: issuer, provisioner: provisioner, cfg: cfg, now: now}
}

func (s *EmailLoginService) Request(
	ctx context.Context, in ChallengeRequest,
) (ChallengeAccepted, error) {
	email, err := validEmail(in.Email)
	if err != nil || !id.Valid(in.ChallengeID) || !validDevice(in.Device) {
		return ChallengeAccepted{}, domain.ErrChallengeInvalid
	}
	rules := []RateLimitRule{
		{Key: s.key("send:cooldown:email", email), Limit: 1, Window: s.cfg.ResendAfter},
		{Key: s.key("send:email", email), Limit: s.cfg.EmailSendLimit, Window: s.cfg.RateWindow},
		{Key: s.key("send:device", in.Device.ID), Limit: s.cfg.DeviceSendLimit, Window: s.cfg.RateWindow},
		{Key: s.key("send:ip", in.RemoteIP), Limit: s.cfg.IPSendLimit, Window: s.cfg.RateWindow},
	}
	allowed, err := s.limiter.Allow(ctx, rules)
	if err != nil {
		return ChallengeAccepted{}, err
	}
	if !allowed {
		return ChallengeAccepted{}, domain.ErrRateLimited
	}
	code, err := generateCode()
	if err != nil {
		return ChallengeAccepted{}, err
	}
	now := s.now()
	expires := now.Add(s.cfg.TTL)
	challenge := domain.EmailChallenge{
		ID: in.ChallengeID, EmailNormalized: email,
		CodeHash: s.hash(in.ChallengeID + "\x00" + code), MaxAttempts: s.cfg.MaxAttempts,
		ExpiresAt: expires, RequestIPHash: s.hash(in.RemoteIP),
		DeviceFingerprintHash: s.hash(in.Device.ID), CreatedAt: now,
	}
	if err := s.challenges.Create(ctx, challenge); err != nil {
		return ChallengeAccepted{}, err
	}
	if err := s.sender.SendLoginCode(ctx, email, code, s.cfg.TTL); err != nil {
		_ = s.challenges.MarkDelivery(ctx, in.ChallengeID, "failed")
		return ChallengeAccepted{}, domain.ErrEmailDelivery
	}
	if err := s.challenges.MarkDelivery(ctx, in.ChallengeID, "sent"); err != nil {
		return ChallengeAccepted{}, err
	}
	return ChallengeAccepted{ChallengeID: in.ChallengeID, ExpiresAt: expires,
		RetryAfterSeconds: int(s.cfg.ResendAfter.Seconds())}, nil
}

func (s *EmailLoginService) Verify(
	ctx context.Context, in VerifyRequest,
) (IssuedSession, error) {
	if !id.Valid(in.ChallengeID) || len(in.Code) != 6 || !digits(in.Code) || !validDevice(in.Device) {
		return IssuedSession{}, domain.ErrChallengeInvalid
	}
	allowed, err := s.limiter.Allow(ctx, []RateLimitRule{
		{Key: s.key("verify:challenge", in.ChallengeID), Limit: s.cfg.VerifyLimit, Window: s.cfg.RateWindow},
		{Key: s.key("verify:device", in.Device.ID), Limit: s.cfg.VerifyLimit, Window: s.cfg.RateWindow},
		{Key: s.key("verify:ip", in.RemoteIP), Limit: s.cfg.VerifyLimit, Window: s.cfg.RateWindow},
	})
	if err != nil {
		return IssuedSession{}, err
	}
	if !allowed {
		return IssuedSession{}, domain.ErrRateLimited
	}
	user, err := s.challenges.VerifyAndResolveUser(
		ctx, in.ChallengeID, s.hash(in.ChallengeID+"\x00"+in.Code), s.now(),
	)
	if err != nil {
		return IssuedSession{}, err
	}
	if err := s.provisioner.EnsureDefault(ctx, user.ID); err != nil {
		return IssuedSession{}, err
	}
	return s.issuer.Issue(ctx, user, in.Device)
}

func (s *EmailLoginService) key(namespace, value string) string {
	return "otp:" + namespace + ":" + hex.EncodeToString(s.hash(value))
}

func (s *EmailLoginService) hash(value string) []byte {
	mac := hmac.New(sha256.New, []byte(s.cfg.HashKey))
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func generateCode() (string, error) {
	var raw [4]byte
	for {
		if _, err := rand.Read(raw[:]); err != nil {
			return "", err
		}
		value := binary.BigEndian.Uint32(raw[:])
		if value < ^uint32(0)-(^uint32(0)%1_000_000) {
			return fmt.Sprintf("%06d", value%1_000_000), nil
		}
	}
}

func validEmail(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed || len(trimmed) > 320 {
		return "", domain.ErrChallengeInvalid
	}
	return NormalizeEmail(trimmed), nil
}

func validDevice(in DeviceInput) bool {
	return id.Valid(in.ID) && domain.ValidPlatform(in.Platform) &&
		len(strings.TrimSpace(in.Name)) >= 1 && len(strings.TrimSpace(in.Name)) <= 120 &&
		len(in.AppVersion) >= 1 && len(in.AppVersion) <= 40
}

func digits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
