package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// newTestHub creates a Hub with generous limits and an httptest.Server wired to /ws.
func newTestHub() (*Hub, *httptest.Server) {
	limits := &Limits{
		MaxSessions:     50,
		MaxParties:      10,
		MaxMessageBytes: 1 << 20,
		MaxPerIP:        100,
		PingInterval:    60 * time.Second,
		AbandonTimeout:  10 * time.Minute,
		ipConns:         make(map[string]int),
	}
	hub := &Hub{
		sessions: make(map[string]*Session),
		limits:   limits,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.handleWS)
	srv := httptest.NewServer(mux)
	return hub, srv
}

// dial opens a WebSocket connection to the test server's /ws endpoint.
func dial(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

// send JSON-marshals msg and writes it to conn.
func send(t *testing.T, conn *websocket.Conn, msg Msg) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// recv reads a message from conn with a 5s timeout and JSON-unmarshals it.
func recv(t *testing.T, conn *websocket.Conn) Msg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var msg Msg
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return msg
}

func TestCreateJoinReady(t *testing.T) {
	_, srv := newTestHub()
	defer srv.Close()

	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	c1 := dial(t, srv)
	defer c1.Close(websocket.StatusNormalClosure, "")
	c2 := dial(t, srv)
	defer c2.Close(websocket.StatusNormalClosure, "")

	// Party 0 creates a 3-party session
	send(t, c0, Msg{Type: "create", Parties: 3, Threshold: 2, Pubkey: "pk0"})
	created := recv(t, c0)
	if created.Type != "created" {
		t.Fatalf("expected type=created, got %s", created.Type)
	}
	if created.Session == "" {
		t.Fatal("expected non-empty session code")
	}
	if created.PartyID == nil || *created.PartyID != 0 {
		t.Fatalf("expected partyId=0, got %v", created.PartyID)
	}
	if created.Token == "" {
		t.Fatal("expected non-empty token")
	}
	sessionCode := created.Session

	// Party 1 joins
	send(t, c1, Msg{Type: "join", Session: sessionCode, Pubkey: "pk1"})
	joined1 := recv(t, c1)
	if joined1.Type != "joined" {
		t.Fatalf("expected type=joined for c1, got %s", joined1.Type)
	}
	if joined1.PartyID == nil || *joined1.PartyID != 1 {
		t.Fatalf("expected partyId=1 for c1, got %v", joined1.PartyID)
	}
	if joined1.Token == "" {
		t.Fatal("expected non-empty token for c1")
	}
	if joined1.Count == nil || *joined1.Count != 2 {
		t.Fatalf("expected count=2, got %v", joined1.Count)
	}
	if joined1.Total == nil || *joined1.Total != 3 {
		t.Fatalf("expected total=3, got %v", joined1.Total)
	}

	// Party 0 receives the broadcast that party 1 joined
	joinBroadcast0 := recv(t, c0)
	if joinBroadcast0.Type != "joined" {
		t.Fatalf("expected joined broadcast for c0, got %s", joinBroadcast0.Type)
	}
	if joinBroadcast0.PartyID == nil || *joinBroadcast0.PartyID != 1 {
		t.Fatalf("expected broadcast partyId=1, got %v", joinBroadcast0.PartyID)
	}

	// Party 2 joins — this should trigger ready
	send(t, c2, Msg{Type: "join", Session: sessionCode, Pubkey: "pk2"})
	joined2 := recv(t, c2)
	if joined2.Type != "joined" {
		t.Fatalf("expected type=joined for c2, got %s", joined2.Type)
	}
	if joined2.PartyID == nil || *joined2.PartyID != 2 {
		t.Fatalf("expected partyId=2 for c2, got %v", joined2.PartyID)
	}

	// All parties should receive "joined" broadcast for party 2 first (c0 and c1)
	joinBroadcast0_2 := recv(t, c0)
	if joinBroadcast0_2.Type != "joined" {
		t.Fatalf("expected joined broadcast for c0 (party 2), got %s", joinBroadcast0_2.Type)
	}
	joinBroadcast1_2 := recv(t, c1)
	if joinBroadcast1_2.Type != "joined" {
		t.Fatalf("expected joined broadcast for c1 (party 2), got %s", joinBroadcast1_2.Type)
	}

	// All parties should receive "ready" with all pubkeys
	ready0 := recv(t, c0)
	ready1 := recv(t, c1)
	ready2 := recv(t, c2)

	for i, r := range []Msg{ready0, ready1, ready2} {
		if r.Type != "ready" {
			t.Fatalf("party %d: expected type=ready, got %s", i, r.Type)
		}
		if len(r.Pubkeys) != 3 {
			t.Fatalf("party %d: expected 3 pubkeys, got %d", i, len(r.Pubkeys))
		}
		if r.Pubkeys[0] != "pk0" || r.Pubkeys[1] != "pk1" || r.Pubkeys[2] != "pk2" {
			t.Fatalf("party %d: unexpected pubkeys %v", i, r.Pubkeys)
		}
		if r.Threshold != 2 {
			t.Fatalf("party %d: expected threshold=2, got %d", i, r.Threshold)
		}
	}
}

func TestRelayMessage(t *testing.T) {
	_, srv := newTestHub()
	defer srv.Close()

	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	c1 := dial(t, srv)
	defer c1.Close(websocket.StatusNormalClosure, "")

	// Create 2-party session and reach ready
	send(t, c0, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk0"})
	created := recv(t, c0)
	sessionCode := created.Session

	send(t, c1, Msg{Type: "join", Session: sessionCode, Pubkey: "pk1"})
	recv(t, c1) // joined (personal)
	recv(t, c0) // joined broadcast

	// Both receive ready
	recv(t, c0) // ready
	recv(t, c1) // ready

	// Party 0 relays to party 1
	send(t, c0, Msg{Type: "relay", To: intPtr(1), Payload: "encrypted-blob-data"})
	relayed := recv(t, c1)
	if relayed.Type != "relay" {
		t.Fatalf("expected type=relay, got %s", relayed.Type)
	}
	if relayed.From == nil || *relayed.From != 0 {
		t.Fatalf("expected from=0, got %v", relayed.From)
	}
	if relayed.Payload != "encrypted-blob-data" {
		t.Fatalf("expected payload 'encrypted-blob-data', got %q", relayed.Payload)
	}
}

func TestSessionFull(t *testing.T) {
	_, srv := newTestHub()
	defer srv.Close()

	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	c1 := dial(t, srv)
	defer c1.Close(websocket.StatusNormalClosure, "")

	// Create 2-party session
	send(t, c0, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk0"})
	created := recv(t, c0)
	sessionCode := created.Session

	// Party 1 joins — session is now full
	send(t, c1, Msg{Type: "join", Session: sessionCode, Pubkey: "pk1"})
	recv(t, c1) // joined (personal)
	recv(t, c0) // joined broadcast
	recv(t, c0) // ready
	recv(t, c1) // ready

	// Third party tries to join
	c2 := dial(t, srv)
	defer c2.Close(websocket.StatusNormalClosure, "")
	send(t, c2, Msg{Type: "join", Session: sessionCode, Pubkey: "pk2"})
	errMsg := recv(t, c2)
	if errMsg.Type != "error" {
		t.Fatalf("expected type=error, got %s", errMsg.Type)
	}
	if errMsg.Message == "" {
		t.Fatal("expected non-empty error message")
	}
}

func TestSelfSendRejected(t *testing.T) {
	_, srv := newTestHub()
	defer srv.Close()

	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	c1 := dial(t, srv)
	defer c1.Close(websocket.StatusNormalClosure, "")

	// Create 2-party session and reach ready
	send(t, c0, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk0"})
	created := recv(t, c0)
	sessionCode := created.Session

	send(t, c1, Msg{Type: "join", Session: sessionCode, Pubkey: "pk1"})
	recv(t, c1) // joined (personal)
	recv(t, c0) // joined broadcast
	recv(t, c0) // ready
	recv(t, c1) // ready

	// Party 0 tries to relay to itself
	send(t, c0, Msg{Type: "relay", To: intPtr(0), Payload: "self-data"})
	errMsg := recv(t, c0)
	if errMsg.Type != "error" {
		t.Fatalf("expected type=error, got %s", errMsg.Type)
	}
	if !strings.Contains(errMsg.Message, "self") {
		t.Fatalf("expected error about self relay, got %q", errMsg.Message)
	}
}

func TestReconnect(t *testing.T) {
	_, srv := newTestHub()
	defer srv.Close()

	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	c1 := dial(t, srv)

	// Create 2-party session and reach ready
	send(t, c0, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk0"})
	created := recv(t, c0)
	sessionCode := created.Session

	send(t, c1, Msg{Type: "join", Session: sessionCode, Pubkey: "pk1"})
	joinedC1 := recv(t, c1)
	tokenC1 := joinedC1.Token

	recv(t, c0) // joined broadcast
	recv(t, c0) // ready
	recv(t, c1) // ready

	// Party 1 disconnects
	c1.Close(websocket.StatusNormalClosure, "")

	// Party 0 should receive "left" for party 1
	left := recv(t, c0)
	if left.Type != "left" {
		t.Fatalf("expected type=left, got %s", left.Type)
	}
	if left.PartyID == nil || *left.PartyID != 1 {
		t.Fatalf("expected left partyId=1, got %v", left.PartyID)
	}

	// Party 1 reconnects with their token
	c1r := dial(t, srv)
	defer c1r.Close(websocket.StatusNormalClosure, "")

	send(t, c1r, Msg{Type: "reconnect", Session: sessionCode, Token: tokenC1})

	// c1r receives personal reconnected acknowledgment
	reconnectedC1 := recv(t, c1r)
	if reconnectedC1.Type != "reconnected" {
		t.Fatalf("expected type=reconnected for c1r, got %s", reconnectedC1.Type)
	}
	if reconnectedC1.PartyID == nil || *reconnectedC1.PartyID != 1 {
		t.Fatalf("expected reconnected partyId=1, got %v", reconnectedC1.PartyID)
	}

	// Party 0 receives broadcast that party 1 reconnected
	reconnectedC0 := recv(t, c0)
	if reconnectedC0.Type != "reconnected" {
		t.Fatalf("expected type=reconnected broadcast for c0, got %s", reconnectedC0.Type)
	}
	if reconnectedC0.PartyID == nil || *reconnectedC0.PartyID != 1 {
		t.Fatalf("expected reconnected partyId=1, got %v", reconnectedC0.PartyID)
	}

	// Verify relay still works after reconnect: c0 sends to party 1 via c1r
	send(t, c0, Msg{Type: "relay", To: intPtr(1), Payload: "after-reconnect"})
	relayed := recv(t, c1r)
	if relayed.Type != "relay" {
		t.Fatalf("expected type=relay, got %s", relayed.Type)
	}
	if relayed.From == nil || *relayed.From != 0 {
		t.Fatalf("expected from=0, got %v", relayed.From)
	}
	if relayed.Payload != "after-reconnect" {
		t.Fatalf("expected payload 'after-reconnect', got %q", relayed.Payload)
	}
}

func TestSessionLimitEnforced(t *testing.T) {
	// Custom hub with MaxSessions=2
	limits := &Limits{
		MaxSessions:     2,
		MaxParties:      10,
		MaxMessageBytes: 1 << 20,
		MaxPerIP:        100,
		PingInterval:    60 * time.Second,
		AbandonTimeout:  10 * time.Minute,
		ipConns:         make(map[string]int),
	}
	hub := &Hub{
		sessions: make(map[string]*Session),
		limits:   limits,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.handleWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Create session 1
	c0 := dial(t, srv)
	defer c0.Close(websocket.StatusNormalClosure, "")
	send(t, c0, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk0"})
	created0 := recv(t, c0)
	if created0.Type != "created" {
		t.Fatalf("session 1: expected type=created, got %s", created0.Type)
	}

	// Create session 2
	c1 := dial(t, srv)
	defer c1.Close(websocket.StatusNormalClosure, "")
	send(t, c1, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk1"})
	created1 := recv(t, c1)
	if created1.Type != "created" {
		t.Fatalf("session 2: expected type=created, got %s", created1.Type)
	}

	// Try to create session 3 — should fail
	c2 := dial(t, srv)
	defer c2.Close(websocket.StatusNormalClosure, "")
	send(t, c2, Msg{Type: "create", Parties: 2, Threshold: 2, Pubkey: "pk2"})
	errMsg := recv(t, c2)
	if errMsg.Type != "error" {
		t.Fatalf("session 3: expected type=error, got %s", errMsg.Type)
	}
	if !strings.Contains(errMsg.Message, "capacity") {
		t.Fatalf("expected capacity error, got %q", errMsg.Message)
	}
}
