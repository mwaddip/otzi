package main

import (
	"testing"
)

func TestGenerateCode(t *testing.T) {
	code := generateCode()
	if len(code) != 6 {
		t.Fatalf("expected 6 chars, got %d: %q", len(code), code)
	}
	for _, c := range code {
		if !isValidCodeChar(c) {
			t.Fatalf("invalid char %c in code %q", c, code)
		}
	}
}

func TestGenerateCodeUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		code := generateCode()
		if seen[code] {
			t.Fatalf("duplicate code %q after %d iterations", code, i)
		}
		seen[code] = true
	}
}

func TestGenerateCodeNoAmbiguous(t *testing.T) {
	ambiguous := "0O1IL"
	for i := 0; i < 1000; i++ {
		code := generateCode()
		for _, c := range code {
			for _, a := range ambiguous {
				if c == a {
					t.Fatalf("ambiguous char %c in code %q", c, code)
				}
			}
		}
	}
}

func TestSessionAddParty(t *testing.T) {
	s := NewSession("ABC123", 3, 2, "https://example.com")
	if s.PartyCount() != 0 {
		t.Fatal("expected 0 parties")
	}

	id, token, nowFull := s.AddParty("pk0", nil)
	if id != 0 || token == "" {
		t.Fatalf("expected id=0, got %d; token empty=%v", id, token == "")
	}
	if nowFull {
		t.Fatal("should not be full after 1 of 3")
	}
	if s.PartyCount() != 1 {
		t.Fatal("expected 1 party")
	}

	id, _, nowFull = s.AddParty("pk1", nil)
	if id != 1 {
		t.Fatalf("expected id=1, got %d", id)
	}
	if nowFull {
		t.Fatal("should not be full after 2 of 3")
	}

	id, _, nowFull = s.AddParty("pk2", nil)
	if id != 2 {
		t.Fatalf("expected id=2, got %d", id)
	}
	if !nowFull {
		t.Fatal("should be full after 3 of 3")
	}
	if s.State != "ready" {
		t.Fatalf("expected state=ready, got %s", s.State)
	}

	// Session full
	id, _, _ = s.AddParty("pk3", nil)
	if id != -1 {
		t.Fatalf("expected -1 for full session, got %d", id)
	}
}

func TestSessionIsFull(t *testing.T) {
	s := NewSession("ABC123", 2, 2, "https://example.com")
	if s.IsFull() {
		t.Fatal("should not be full with 0 parties")
	}
	s.AddParty("pk0", nil)
	if s.IsFull() {
		t.Fatal("should not be full with 1 party")
	}
	s.AddParty("pk1", nil)
	if !s.IsFull() {
		t.Fatal("should be full with 2 parties")
	}
}

func TestSessionPubkeys(t *testing.T) {
	s := NewSession("ABC123", 2, 2, "https://example.com")
	s.AddParty("pk_alice", nil)
	s.AddParty("pk_bob", nil)
	pks := s.Pubkeys()
	if pks[0] != "pk_alice" || pks[1] != "pk_bob" {
		t.Fatalf("unexpected pubkeys: %v", pks)
	}
}

func TestSessionReconnectByToken(t *testing.T) {
	s := NewSession("ABC123", 2, 2, "https://example.com")
	_, token, _ := s.AddParty("pk0", nil)
	p := s.GetPartyByToken(token)
	if p == nil || p.ID != 0 {
		t.Fatal("expected to find party 0 by token")
	}
	if s.GetPartyByToken("wrong-token") != nil {
		t.Fatal("should not find party with wrong token")
	}
}
