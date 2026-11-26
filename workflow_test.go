package main

import (
	"os"
	"slices"
	"testing"

	"go.yaml.in/yaml/v3"
)

// The protected check must include every CI job. A newly added job must not
// silently become optional when someone forgets to add its name to needs.
func TestRequiredJobs(t *testing.T) {
	var workflow struct {
		Jobs map[string]struct {
			Needs []string
			If    string
			Env   map[string]string
		}
	}
	raw, err := os.ReadFile(".github/workflows/test.yml")
	if err != nil {
		t.Fatal(err)
	}
	if err = yaml.Unmarshal(raw, &workflow); err != nil {
		t.Fatal(err)
	}
	gate, ok := workflow.Jobs["gate"]
	if !ok || gate.If != "always()" || gate.Env["JOB_RESULTS"] != "${{ toJSON(needs) }}" {
		t.Fatal("The protected check must evaluate every prerequisite, even after a failure")
	}
	for job := range workflow.Jobs {
		if job != "gate" && !slices.Contains(gate.Needs, job) {
			t.Errorf("Required check omits %q", job)
		}
	}
}
