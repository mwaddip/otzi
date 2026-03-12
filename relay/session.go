package main

import (
	"crypto/rand"
	"math/big"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// Session code alphabet: uppercase + digits, no ambiguous chars (0,O,1,I,L)
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
const codeLength = 6

func generateCode() string {
	b := make([]byte, codeLength)
	max := big.NewInt(int64(len(codeAlphabet)))
	for i := range b {
		n, _ := rand.Int(rand.Reader, max)
		b[i] = codeAlphabet[n.Int64()]
	}
	return string(b)
}

func isValidCodeChar(c rune) bool {
	for _, a := range codeAlphabet {
		if c == a {
			return true
		}
	}
	return false
}

// Party represents a connected ceremony participant.
type Party struct {
	ID        int
	Pubkey    string // base64-encoded ECDH public key
	Token     string // reconnection token
	Conn      *websocket.Conn
	Connected bool
	mu        sync.Mutex
}

// Session represents a ceremony session.
type Session struct {
	Code      string
	Parties   int // expected party count
	Threshold int
	State     string // "waiting", "ready", "active"
	BaseURL   string

	PartyList []*Party
	mu        sync.RWMutex

	CreatedAt    time.Time
	LastActivity time.Time
}

// NewSession creates a session with the given parameters.
func NewSession(code string, parties, threshold int, baseURL string) *Session {
	now := time.Now()
	return &Session{
		Code:         code,
		Parties:      parties,
		Threshold:    threshold,
		State:        "waiting",
		BaseURL:      baseURL,
		PartyList:    make([]*Party, 0, parties),
		CreatedAt:    now,
		LastActivity: now,
	}
}

// AddParty adds a new party and returns the assigned party ID.
// Returns -1 if the session is full. The nowFull return value indicates
// whether this addition made the session full and transitioned State to "ready".
// This is atomic — no race between checking fullness and transitioning state.
func (s *Session) AddParty(pubkey string, conn *websocket.Conn) (id int, token string, nowFull bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.PartyList) >= s.Parties {
		return -1, "", false
	}

	token = generateToken()
	id = len(s.PartyList)
	p := &Party{
		ID:        id,
		Pubkey:    pubkey,
		Token:     token,
		Conn:      conn,
		Connected: true,
	}
	s.PartyList = append(s.PartyList, p)
	s.LastActivity = time.Now()

	if len(s.PartyList) >= s.Parties && s.State == "waiting" {
		s.State = "ready"
		nowFull = true
	}

	return id, token, nowFull
}

// PartyCount returns the number of parties that have joined.
func (s *Session) PartyCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.PartyList)
}

// IsFull returns true if all expected parties have joined.
func (s *Session) IsFull() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.PartyList) >= s.Parties
}

// Pubkeys returns a map of partyId -> base64 pubkey.
func (s *Session) Pubkeys() map[int]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := make(map[int]string, len(s.PartyList))
	for _, p := range s.PartyList {
		m[p.ID] = p.Pubkey
	}
	return m
}

// GetParty returns the party with the given ID, or nil.
func (s *Session) GetParty(id int) *Party {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if id < 0 || id >= len(s.PartyList) {
		return nil
	}
	return s.PartyList[id]
}

// GetPartyByToken finds a party by reconnection token.
func (s *Session) GetPartyByToken(token string) *Party {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.PartyList {
		if p.Token == token {
			return p
		}
	}
	return nil
}

// HasConnected returns true if at least one party is connected.
func (s *Session) HasConnected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.PartyList {
		if p.Connected {
			return true
		}
	}
	return false
}

func generateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 64)
	for i, v := range b {
		out[i*2] = hex[v>>4]
		out[i*2+1] = hex[v&0x0f]
	}
	return string(out)
}
