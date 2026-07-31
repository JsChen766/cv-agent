package config

func loadEmailOTP(cfg *Config, lookup lookupFunc) error {
	cfg.Email.Provider = value(lookup, "EMAIL_PROVIDER", "mailpit")
	cfg.Email.SMTPAddress = value(lookup, "SMTP_ADDRESS", "mailpit:1025")
	cfg.Email.SenderEmail = value(
		lookup, "EMAIL_SENDER_ADDRESS", "no-reply@coolto.local",
	)
	cfg.Email.SenderName = value(lookup, "EMAIL_SENDER_NAME", "Coolto")
	cfg.Email.BrevoAPIBaseURL = value(lookup, "BREVO_API_BASE_URL", "https://api.brevo.com/v3")
	cfg.Email.BrevoAPIKey = value(lookup, "BREVO_API_KEY", "")
	cfg.Email.BrevoSenderEmail = value(lookup, "BREVO_SENDER_EMAIL", "")
	cfg.Email.BrevoSenderName = value(lookup, "BREVO_SENDER_NAME", "CV Agent")
	cfg.Email.BrevoReplyTo = value(lookup, "BREVO_REPLY_TO", "")
	var brevoTemplateErr error
	cfg.Email.BrevoTemplateID, brevoTemplateErr = intValue(lookup, "BREVO_TEMPLATE_ID", 0)
	if brevoTemplateErr != nil {
		return brevoTemplateErr
	}
	cfg.OTP.HashKey = value(lookup, "OTP_HASH_KEY", "")
	if cfg.OTP.HashKey == "" && isDevelopmentEnvironment(cfg.Environment) {
		cfg.OTP.HashKey = "local-only-otp-hash-key-change-before-production"
	}
	var err error
	cfg.OTP.TTL, err = duration(lookup, "OTP_TTL", "10m")
	if err != nil {
		return err
	}
	cfg.OTP.ResendAfter, err = duration(lookup, "OTP_RESEND_AFTER", "60s")
	if err != nil {
		return err
	}
	cfg.OTP.RateWindow, err = duration(lookup, "OTP_RATE_WINDOW", "15m")
	if err != nil {
		return err
	}
	cfg.OTP.MaxAttempts, err = intValue(lookup, "OTP_MAX_ATTEMPTS", 5)
	if err != nil {
		return err
	}
	cfg.OTP.EmailSendLimit, err = intValue(lookup, "OTP_EMAIL_SEND_LIMIT", 5)
	if err != nil {
		return err
	}
	cfg.OTP.DeviceSendLimit, err = intValue(lookup, "OTP_DEVICE_SEND_LIMIT", 10)
	if err != nil {
		return err
	}
	cfg.OTP.IPSendLimit, err = intValue(lookup, "OTP_IP_SEND_LIMIT", 20)
	if err != nil {
		return err
	}
	cfg.OTP.VerifyLimit, err = intValue(lookup, "OTP_VERIFY_LIMIT", 10)
	return err
}
