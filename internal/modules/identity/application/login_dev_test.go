package application

import (
	"context"
	"errors"
	"testing"

	"coolto.local/cv-agent-app-be/internal/modules/identity/domain"
)

type userRepoStub struct {
	user domain.User
	err  error
}

func (s userRepoStub) FindActiveByNormalizedEmail(
	context.Context, string,
) (domain.User, error) {
	return s.user, s.err
}

type credentialRepoStub struct {
	err error
}

func (s credentialRepoStub) FindPasswordHash(context.Context, string) (string, error) {
	return "", s.err
}

func TestDevLoginPreservesUserRepositoryFailure(t *testing.T) {
	t.Parallel()
	repositoryFailure := errors.New("database unavailable")
	service := NewDevLoginService(
		userRepoStub{err: repositoryFailure},
		credentialRepoStub{},
		nil,
		nil,
		"test",
	)

	_, err := service.Login(context.Background(), DevLoginInput{
		Email: "user@example.com", Password: "password",
	})
	if !errors.Is(err, repositoryFailure) {
		t.Fatalf("expected repository failure, got %v", err)
	}
}

func TestDevLoginPreservesCredentialRepositoryFailure(t *testing.T) {
	t.Parallel()
	repositoryFailure := errors.New("database unavailable")
	service := NewDevLoginService(
		userRepoStub{user: domain.User{ID: "user", Status: domain.UserStatusActive}},
		credentialRepoStub{err: repositoryFailure},
		nil,
		nil,
		"test",
	)

	_, err := service.Login(context.Background(), DevLoginInput{
		Email: "user@example.com", Password: "password",
	})
	if !errors.Is(err, repositoryFailure) {
		t.Fatalf("expected repository failure, got %v", err)
	}
}
