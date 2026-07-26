package contractfixture

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFrozenJSONFixtures(t *testing.T) {
	root := repositoryRoot(t)
	fixtureRoot := filepath.Join(root, "contracts", "app-v1")
	fixtureCount := 0

	err := filepath.WalkDir(fixtureRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		if filepath.Base(path) == "source-manifest.json" {
			return nil
		}
		fixtureCount++
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		var value any
		if jsonErr := json.Unmarshal(body, &value); jsonErr != nil {
			t.Errorf("%s is not valid JSON: %v", path, jsonErr)
		}
		if strings.HasSuffix(path, ".response.json") {
			assertEnvelope(t, path, value)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixtureCount < 21 {
		t.Fatalf("expected at least 21 frozen payload fixtures, got %d", fixtureCount)
	}
}

func TestFrozenSurfaceExcludesAgentEndpoints(t *testing.T) {
	root := repositoryRoot(t)
	body, err := os.ReadFile(filepath.Join(root, "api", "openapi", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	spec := strings.ToLower(string(body))
	for _, path := range []string{"/v1/agent", "/v1/llm", "/v1/chat", "/v1/prompts"} {
		if strings.Contains(spec, path) {
			t.Errorf("excluded APP-owned endpoint appears in OpenAPI: %s", path)
		}
	}
}

func assertEnvelope(t *testing.T, path string, value any) {
	t.Helper()
	envelope, ok := value.(map[string]any)
	if !ok {
		t.Errorf("%s must contain an object envelope", path)
		return
	}
	success, ok := envelope["success"].(bool)
	if !ok {
		t.Errorf("%s must contain a boolean success field", path)
		return
	}
	requiredField := "error"
	if success {
		requiredField = "data"
	}
	if _, ok := envelope[requiredField]; !ok {
		t.Errorf("%s must contain %s", path, requiredField)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
}
