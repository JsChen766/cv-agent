package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"coolto.local/cv-agent-app-be/internal/modules/experience/domain"
)

type revisionRepositoryStub struct {
	Repository
	exists         bool
	listCalled     bool
	requestedUser  string
	requestedID    string
	requestedAfter int
	requestedLimit int
	revisions      []domain.Revision
}

func (r *revisionRepositoryStub) Exists(
	_ context.Context, userID, id string,
) (bool, error) {
	r.requestedUser = userID
	r.requestedID = id
	return r.exists, nil
}

func (r *revisionRepositoryStub) ListRevisions(
	_ context.Context, userID, expID string, afterNumber, limit int,
) ([]domain.Revision, error) {
	r.listCalled = true
	r.requestedUser = userID
	r.requestedID = expID
	r.requestedAfter = afterNumber
	r.requestedLimit = limit
	return r.revisions, nil
}

func TestListRevisionsRejectsMissingOrForeignExperience(t *testing.T) {
	repo := &revisionRepositoryStub{exists: false}
	service := NewService(nil, repo, nil, nil, time.Now)
	_, err := service.ListRevisions(context.Background(), "user-a", "foreign", 0, 10)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
	if repo.listCalled {
		t.Fatal("revision query must not run after ownership check fails")
	}
}

func TestListRevisionsRequestsOneLookaheadRow(t *testing.T) {
	repo := &revisionRepositoryStub{
		exists:    true,
		revisions: []domain.Revision{{ID: "revision-1"}},
	}
	service := NewService(nil, repo, nil, nil, time.Now)
	items, err := service.ListRevisions(
		context.Background(), "user-a", "experience-a", 24, 10,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !repo.listCalled {
		t.Fatalf("unexpected revision result: %#v", items)
	}
	if repo.requestedUser != "user-a" || repo.requestedID != "experience-a" {
		t.Fatalf("ownership scope drifted: %s/%s", repo.requestedUser, repo.requestedID)
	}
	if repo.requestedAfter != 24 || repo.requestedLimit != 11 {
		t.Fatalf("expected after=24 limit=11, got after=%d limit=%d",
			repo.requestedAfter, repo.requestedLimit)
	}
}
