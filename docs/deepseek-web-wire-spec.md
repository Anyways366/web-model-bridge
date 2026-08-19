# DeepSeek Web (chat.deepseek.com) Wire Protocol Spec

Version: 1.0 (monolithic reference)
Status: frozen reference. Implementation freeze: **do not change `src/` protocol logic until N/S.
Evidence tiers for every field:
- **[OBSERVED]** — captured from real network traffic (raw-api-reference.md transcript, byte-verified prompt fixtures in tests).
- **[REF-DERIVED]** — derived from the proven-working reference implementation (ds-free-api fork: `ds_core/src/accounts/*`), including exact strings and algorithm behavior.
- **[INFERRED]** — reasoned from evidence or general behavior; marked where verification is still open.

---

## 1. Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `https://chat.deepseek.com/api/v0/chat/completion` | POST | All chat traffic (normal + file-assisted) [OBSERVED] |
| `https://chat.deepseek.com/api/v0/chat/collapse_message` | GET | Session left panel collapse [REF-DERIVED] |
| `https://chat.deepseek.com/api/v0/chat/delete_session` | GET | Delete a session [OBSERVED, unused by us] |
| `https://chat.deepseek.com/api/v0/chat/edit_message` | GET | Edit a message / conversation (token/message-count corrections) [REF-DERIVED, unused by us] |
| `https://chat.deepseek.com/api/v0/chat/message_feedback` | GET | Feedback endpoint [REF-DERIVED, unused by us] |
| `https://chat.deepseek.com/api/v0/chat/recreate_session` | GET | [?] [REF-DERIVED, unused] |
| `https://chat.deepseek.com/api/v0/chat/session/history` | GET | Multi-message history payload for a session [REF-DERIVED, unused] |
| `https://chat.deepseek.com/api/v0/chat/session/list` | GET | Session list payload [REF-DERIVED, unused] |
| `https://chat.deepseek.com/api/v0/chat/session/set_last_session` | GET | [?] [REF-DERIVED, unused] |
| `https://chat.deepseek.com/api/v0/login/login` | POST | Login flow [REF-DERIVED, unused by us — we proxy page credentials] |
| `https://chat.deepseek.com/api/v0/login/logout` | GET | Logout [REF-DERIVED, unused] |
| `https://chat.deepseek.com/api/v0/chat/upload_file` | POST | File/attachments (multipart) [OBSERVED — file path only] |
| `https://chat.deepseek.com/api/v0/users/get_user_info` | GET | Account info [INFERRED, unused] |
| `https://chat.deepseek.com/api/v0/test_model/post_test_model` | POST | [?] [INFERRED, unused] |
| `https://chat.deepseek.com/api/v0/chat/stop_stream` | GET | Abort an ongoing response; requires route: `chunk_id=chat_agent&last_messaged_id={response_message_id}` [OBSERVED — our provider has no abort-triggered teardown; see §14] |

PoW challenge endpoint: challenge is delivered as the FIRST SSE event; the PoW response travels on the
`x-ds-pow-response` request header of the completion POST itself [OBSERVED].

### Session lifecycle (what we actually use)

```
PREFLIGHT (per request, from finalizeConfig/authorization interceptor):
  GET  /api/v0/chat/create_session           -> { biz_code, status, data: { id, chat_session_id }, ... }
  POST /api/v0/chat/prompt                    -> { prompt, id: prompt_id }
           body: { "content": "v1", "mode": "advanced" }            [REF-DERIVED]
CHAT (per request):
  POST /api/v0/chat/completion                -> SSE stream [OBSERVED]
  POST /api/v0/chat/update_session            -> { chat_session_id, response_message_id } [OBSERVED]
TEARDOWN (currently unused by us):
  GET  /api/v0/chat/stop_stream?chunk_id=chat_agent&last_messaged_id={response_message_id}
  GET  /api/v0/chat/delete_session?chat_session_id={id}              [OBSERVED]
```

---

## 2. Headers & authentication

Request headers sent on every API call [REF-DERIVED from interceptor slices]:

| Header | Value |
|---|---|
| `authorization` | `Bearer {token}` — `user.token` from the login response [OBSERVED]. Our provider intercepts it from the logged-in tab instead of logging in [design]. |
| `x-app-version` | `20250620.0` (the version baked into both the reference and our interceptor) [OBSERVED] |
| `x-client-version` | `1.0.0-alpha-20250620-01` (versioned; the reference bumps the patch per commit) [OBSERVED] |
| `origin` | `https://chat.deepseek.com` [REF-DERIVED] |
| `referer` | `https://chat.deepseek.com/` [REF-DERIVED] |
| `user-agent` | **Optional**; presence not required [REF-DERIVED] |
| `x-ds-pow-response` | Only on `/completion`: base64 of JSON `{ algorithm, challenge, salt, answer, signature, target_path }` [OBSERVED, exact structure REF-DERIVED] |

X-Client-Version provenance [REF-DERIVED]:
- commit `de1a1e1`: `1.0.0-alpha-20250110-310` — used for `reasoning`, default/expert `model_type`, `search`.
- later commits: `1.0.0-alpha-20250207-449`, `1.0.0-alpha-20250620-01` — the last (20250620-01) is ours.
- Sending an OLD x-client-version can break `model_type=expert` and search (server-side feature gating). Keep ours current.

`origin`/`referer` and `user-agent`: the reference sends them, but their absence was never reproved
to break anything in captures [INFERRED — keep sending them, zero cost].

---

## 3. PoW flow

First SSE event on `/completion` is a `ping` event whose `data` is the PoW challenge [OBSERVED]:

```
event: ping
data: {"v":{"response":{"algorithm":"DeepSeekHashV1","challenge":"xyz...","salt":"0b3...",
      "signature":"ierxx8...","difficulty":144000,"expire_at":300000,"target_path":"/?q=..."}}}
```

Fields: `algorithm` = `DeepSeekHashV1` | `sha256`; `difficulty` 144000-class; `expire_at` 300000 (ms).
On `sha256` challenge difficulty>1000 is log2-scaled in the solver — a solver detail, not wire [REF-DERIVED].

Solve: find `answer` such that the hash matches the target; then send the solved PoW in the completion
request via `x-ds-pow-response` = base64(JSON) of:

```
{"algorithm": "...", "challenge": "...", "salt": "...", "answer": <int>, "signature": "...", "target_path": "..."}
```

Both implementations send extra echo fields (`difficulty`, `expire_at`) — harmless, server accepts [REF-DERIVED].

Flow [OBSERVED]:
1. POST /completion WITHOUT the PoW header → first SSE event is `ping` (challenge).
2. Solve, POST /completion WITH `x-ds-pow-response` → first SSE event is `ready`.
3. If the challenge was never sent (e.g. error page): POST again without the header; eventually the ping arrives.

---

## 4. Completion request body

MIME: `application/json` (content-type header: `application/json; charset=utf-8` seems not required; JSON body
with `application/json` is what the reference actually sends) [REF-DERIVED].

Full body on the normal path (chat with thinking, per our reads — the
reference's `CompletionPayload`; `parent_message_id` is `null` on the first
turn and the wire capture shows it sent explicitly):

```json
{
  "chat_session_id": "abc",
  "parent_message_id": 2,
  "model_type": "expert",
  "prompt": "<operation-folded text>",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": true,
  "preempt": false
}
```

| Field | Type | Always sent? | Notes | Evidence |
|---|---|---|---|---|
| `chat_session_id` | str | yes | from create_session | [OBSERVED] |
| `parent_message_id` | int\|null | yes (null on first turn) | message_id to continue from; null chains from the first `ready` response_message_id | [OBSERVED] |
| `model_type` | str | yes | `default` / `expert` / `vision` (see §5) | [OBSERVED] |
| `prompt` | str | yes | operation-folded text incl. history & attachments | [OBSERVED] |
| `ref_file_ids` | []string | yes ([] when nothing uploaded) | string ids from upload_file; session-level memory | [OBSERVED] |
| `thinking_enabled` | bool | yes | shows/hides the think block | [OBSERVED] |
| `search_enabled` | bool | yes | web search | [OBSERVED] |
| `preempt` | false | yes (chunk path) | forces a new chunks-carrying POST | [REF-DERIVED] |
| `files` | [] | parcel uploads only | file payloads in the file-assisted path | [OBSERVED] |
| `stock_tool_ids`  | []string | in constraint tests | stock tool list | [OBSERVED] |
| `tool_call_ids`   | []string | in tool_canary tests | incoming tool-call ids (idempotency) | [OBSERVED] |

Server-side validation: missing required fields → HTTP 422 with `detail[].loc = body.<field>` [OBSERVED].
Optional fields the server accepts without complaint: `request_id` (request identifier), any extra
unknown fields (no strict validation) [INFERRED — no 422 claims proven, but requirement is missing required
fields only].

---

## 5. model_type

Accepted values [REF-DERIVED from config + OBSERVED ready echoes]:

| Value | Meaning |
|---|---|
| `default` | "default" tier — Web access default; char limit 2621440 (see §6) |
| `expert` | "expert" tier — billable/DeepSeek flagship; char limit 163840; often requires CURRENT x-client-version |
| `vision` | vision-capable model [REF-DERIVED from config comments] |

Semantics [REF-DERIVED]:
- `model_type` is echoed in the `/stream_history` and `ready` payloads (`{"model_type": "expert"}`).
- When only ONE of the models (default/expert) is available, requests with the other open-code model id → 404.
- README for the reference's web client: LOOKUP — note whether `yarun` respects it.

Our OpenCode model id demux [design constraint, matches reference]:
- OpenCode `deepseek-expert` → web `model_type: "expert"`
- OpenCode `deepseek-default` → web `model_type: "default"`

Current provider gap: `deepseek-default` / `deepseek-expert` ids are NOT demuxed at the
provider-model-consumer seam yet; see §15 P2.

---

## 6. Input char limits (operation-folding)

Reference implementation limits (`ds_free_api_lib/models/chat.rs`, MAX_INPUT_CHARS) [REF-DERIVED]:

| Model (client id) | max_chars |
|---|---|
| `default` | 2621440 |
| `expert` | 163840 |

Config effect [REF-DERIVED]: max_chars == 2621440 → default model is used for most requests; web chat
(auto) usually honors it.

---

## 7. prepare_message / prompt / session

Operation-folding (single operation from multiple messages) [REF-DERIVED, exact functions in
reference `ds_core/src/accounts/client.rs`]:

```
Message[input, content, tool_call_id] --TEST-BODY?--> operation-folded prompt
```

How: `prepare_message` takes the raw message list, strips it to the operation fold set
(`op_type: insights|append|...)`, and builds one prompt. The final SET of strings the prompt is built
from (`message_sets.py` algorithms + `prepare_message` for file upload) is what we mirror.

Prompt construction (our captured prompts, byte-verified against the reference `prompt.rs` behavior):
```
<|operation▁begin|><|operation▁begin|>...<|operation▁end|>
history: map message content, tool results, attachments
attachments (<file▁attachment▁content▁begin|>...<|file▁attachment▁content▁end|>)
prompt: <|user▁begin|>...<|user▁end|>
<|operation▁end|>
```

Tool results block (user role): `｜tool▁outputs▁begin｜` ... `｜tool▁output▁begin｜<id>｜tool▁output▁content▁begin｜<text>｜tool▁output▁content▁end｜<id>｜tool▁output▁end｜` ... `｜tool▁outputs▁end｜`
Tool calls block: `<|tool▁calls▁begin|><|tool▁call▁begin|><|tool▁call▁id▁begin|><id>...<|tool▁call▁end|><|tool▁calls▁end|>`

Session creation request (per request; chunks SHARE one session per request) [REF-DERIVED]:
```
POST /api/v0/chat/create_session
body: {}
```
Response: `{ biz_code: 0, status: 0, data: { id, chat_session_id } }` [REF-DERIVED].

Prompt request [REF-DERIVED]:
```
POST /api/v0/chat/prompt
body: { "content": "v1", "mode": "advanced" }
```
Response: `{ status: 0, prompt: "...", user_feature_config: { enable_web_search: true, ... } }`
(only `status` and `prompt` are read).

`user_feature_config.enable_web_search` is checked to decide whether search is available [REF-DERIVED].

---

## 8. SSE event envelopes & event types

Stream framing [OBSERVED]: SSE `event:`/`data:` lines; the stream MAY contain plain JSON lines
(newline-delimited) instead of proper SSE beginnings — the parser must accept both.

`ready` event [OBSERVED]:

```
event: ready
data: {"biz_code":0,"status":0,"data":{"chat_id":"...","session_id":"...",
      "message_id":1,"request_message_id":1715167018...,"response_message_id":1715167018...,
      "conversation_id":"...","model_type":"expert","finish_reason":null}}
```

Usually arrives after 1–2 events (the first can be the `ping` when PoW was not sent yet).

`update_session` event [OBSERVED]:

```
event: update_session
data: {"biz_code":0,"status":0,"data":{"chat_session_id":"...","response_message_id":"1715167018...",
      "conversation_id":"...","message_id":1}}
```

`content` (quasi echo for pieces) [OBSERVED]:

```
event: content
data: {"v":{"response":{"role":"assistant","parent_id":1715167018...,"raw_content":{"content_type":"thinking"|"text","chunk_id":...}},
      "request_id":"..."}}
```

`status` event when finished [OBSERVED]:

```
event: status
data: {"status":0,"biz_code":0,"data":{"status":"FINISHED","quasi_status":"finish",
      "finish_code":null,"message_id":1,"parent_id":2,...,"errors":[null]}}
```

Event types observed in captures: `ping`, `ready`, `update_session`, `content`, `title`, `response/status`,
`close` [OBSERVED]. `close` carries the final token snapshot:

```
event: close
data: {... "message_id":1, "parent_id":2, ..., "token_usage" ...}
```

Quasi status values: `finish` (normal) / `incomplete` (truncated); `status` = `FINISHED` / `INCOMPLETE` [OBSERVED].

The stream ends with a final `response/status` line carrying `data.status == "done"` when all pieces are
done (duplicated QUASI status line replacement) [OBSERVED capture depth; some captures show a bare
`data:` "done" landing before that; marking as observed with doubt].

`think` fragment: reported via `content` event `raw_content.content_type == "thinking"` in a capture;
the actual fragment text lives in the `data.raw_content.fragments` list as `{"type":"think","text":"..."}` [OBSERVED].

---

## 9. Message IDs and parent chaining

Sources of the ID to use as `parent_message_id` [OBSERVED + REF-DERIVED]:
- `ready.response_message_id` (primary — the reference uses this, with fallbacks to `ready.message_id + 1`
  and hard-fallback (1, 2)).
- `update_session.data.response_message_id` (also present) — the reference prefers the ready value.
- Fallback (1, 2) [REF-DERIVED — defensive; captures show the ready response_message_id always present].

Scoping [REF-DERIVED from edit_message + session semantics]: `message_id` values are scoped to a
`chat_session_id`; within a session the response_message_id changes after every completion
(message chain). They are numeric strings (`1715167018...`).

Per chunk (file-assisted path): each chunk's completion gets a NEW `response_message_id`; the reference
chains chunks by sending `parent_message_id = <previous chunk's response_message_id>` across the
per-chunk POSTs that share one `chat_session_id` [REF-DERIVED].

Tool calls: TOOL CALLS HAVE NO `message_id` OF THEIR OWN — tool calls are text markers inside the prompt,
not separate messages; the completion IDs chain every turn [REF-DERIVED].

Sleep between chunk completions: no explicit sleep — the chunked path relies on the server's own
rate limits (500ms sleep only when `Overloaded` is returned) [REF-DERIVED].

---

## 10. update_session custody

After obtaining `response_message_id`, the reference POSTs `update_session` with the NEW id [OBSERVED]:

```
POST /api/v0/chat/update_session
{ chat_session_id, response_message_id }
```

Use: session "last message" maintenance. Not a failure point: missing this does not break completions.

---

## 11. Tool calls / attachments

Tool calls and tool results are NOT SSE events — they are prompt-side markers (§7) [REF-DERIVED].
Attachment upload (§1 `upload_file`) is a multipart POST whose `files[].id` lands in `chat_req.files`.
Attachments appear in the prompt as `<file▁attachment▁content▁begin|>...<|file▁attachment▁content▁end|>`
blocks [OBSERVED — our prompts].

Attachment behavior notes [REF-DERIVED/INFERRED mixed]:
- Images/other types in the attachment use base64/`attachment_link` content; user-uploaded images do not
- A user-uploaded file in the same request as chat creates ">128 B" files.
- The reference limits question length differently per model; see §6.

---

## 12. Search

Toggled client-side: `search_enabled` in the completion body [OBSERVED]. Server-side presence of search:
`enable_web_search` from the `prompt` preflight call decides availability.

When on:
- `search_status` non-null in the completion; a `TOOL_SEARCH` / `TOOL_OPEN` fragment chunk arrives in
  the `raw_content.fragments` (with `type: "tool_chunk"`) making search collectible in `finish_reason` [OBSERVED].
- Immediate vs deferred search follows the prompt-side markers: if the prompt contains explicit
  search-activation markers, search runs synchronously; otherwise it's deferred to a follow-up (per
  the web client's search toggle state) [REF-DERIVED].

### Search + tool-call edge cases [RECORDED]

1. When the response starts with a search, the client pushes a "thinking" chunk (‹notated›…) [OBSERVED].
2. Search + `message_id` reuse: the reference reused a session_id across rounds for tool calls (implying
   the stable same-session parent chaining) [REF-DERIVED].
3. Vision-only vs search: `vision` requests do NOT trigger search fragments; `default`/'expert' do [INFERRED].

Default `search_enabled` in the reference resolver: **true** — the reference's product default is search ON
(config `reasoning_effort=high` → thinking; search default ON) [REF-DERIVED].
**Our provider will default `search_enabled: false`** [INFERRED recommendation]: the reference's default
is its product choice; for agent providers, injecting search-result fragments into the response text
breaks the strict marker protocol — reasoning documented in `src/providers/deepseek/index.ts` when the
demux lands (P2).

Thinking default in the reference resolver: `reasoning_effort` defaults to `high` and is passed down as
`thinking_enabled=true` [REF-DERIVED]; raw web default shown in captures is ON (think block present) [OBSERVED].

---

## 13. Error envelope & error taxonomy

Error envelope (JSON, non-SSE) per `error!()` / `parse_json_error` [REF-DERIVED]:

```json
{ "code": 40313, "biz_code": null, "message": "...", "errors": [...] }
```

Errors surfaced as chat errors (HTTP 422 from validation has `detail[].loc`, §4) [OBSERVED].

Named error classes in the reference (mapped for the adapter and tests) [REF-DERIVED]:
- `Overloaded` — `{"code": 503, "status": 503, "message": "Service is overloaded"}`; retried with 500ms sleep, max 3 attempts.
- `UnsupportedModel` — `{"message": "invalid model"}`; abort chat, pick another model.
- `NoAvailableAccount` / `SessionTimeout` — account-pool states, not wire errors.
- 403 (invalid token / login flag), 401, 429 (rate limit `hit_limit`), 502/503 (service/temporary).
- 422 validation `invalid input` (detail loc) [OBSERVED].

The adapter surfaces 5xx on overload status; any error that is not the named set aborts the stream [REF-DERIVED].

complete-error detection in the parser (current behavior) [REF-DERIVED, ours]: a JSON object whose `code`
is a number is a complete error; the parser surfaces `CoreError::Api` with the message; no stream recovery.

---

## 14. Stream termination sequence

Local end-state (expected on the chat stream) [OBSERVED, normal captured sequence]:
1. `title` event (may come late)
2. `status` FINISHED (or INCOMPLETE) with `quasi_status`
3. `close` event carrying token usage
4. final `response/status` line `data.status == "done"`

Control-message aborts we do NOT perform (gap):
- `stop_stream` (client disconnect/web-chat abort) → we currently signal the OpenCode stream and don't
  call the endpoint [OBSERVED endpoint exists; OURS: no teardown].
- `delete_session` on session close [OBSERVED endpoint exists; OURS: sessions are recycled].

[OBSERVED] The verify-failure of any capture of the "no-final-event" case: after returning from /completion with
raw stream, the reference read loop treats EOF with pending partial data as an incomplete stream
(`sys.exit` when `ocma` [stream code] returns None) — documented here so the behavior in qa_test is known
to be: stream ends with `data.status == "done"` OR the loop hits EOF and treats the response as
incomplete-but-usable [REF-DERIVED].

---

## 15. Tool APIs / model demux / open items

### Tool-call API (client side, outside the wire protocol)

Tool definitions & results are handled entirely by the CLIENT (caller of the reference adapter); the
wire/SSE never carries them (§11). The reference adapter_cli example (`tool_call_multi_turn.json`) shows
the caller looping: send completion → detect tool-call markers in text → run tool → re-call with the
tool output appended as a tool-results block. [REF-DERIVED]

### Session reuse in the reference: NONE across requests
`create_session` runs once per `v0_chat` call; every request is a fresh session; the parent chain is
per-request (chunks share a session inside a request). The "session_reuse" video claim was NOT
reproved in the reference's defines [REF-DERIVED]. Our provider's long-lived session per role is a
**design decision extending the reference** — parent_message_id chaining across turns relies on
`message_id` scoping to `chat_session_id` [OBSERVED id semantics]; safe because ids are re-fetched
from `ready` each turn.

### Model demux
OpenCode model ids → `model_type` wire mapping [design constraint, REF-DERIVED values],
implemented in `src/providers/deepseek/tools.ts` (`resolveDeepSeekModel`):
- `deepseek-expert` → `expert` (thinking only for reasoner-named ids)
- `deepseek-default` → `default`
- `deepseek-vision` → `vision`
- Legacy aliases: `deepseek-v4` → default, `deepseek-v4-reasoner` → default + thinking.
`search_enabled` defaults to FALSE for all ids (frozen §12 decision).

### Request-body fixture
Expected normal-path completion body (see `tests/unit/providers/deepseek-body.test.ts`, pure fixture;
corrected 2026-08-19 against the raw-api-reference capture — `ref_file_ids` IS part of the wire body,
and the first-turn `parent_message_id` is `null`):

```json
{
  "chat_session_id": "abc",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "preempt": false
}
```

### Open items log
- [x] PoW flow sequencing confirmed vs capture (ping → solve → ready) — §3.
- [x] ready IDs confirmed scoped-per-session, changes per completion — §9.
- [x] tool calls are prompt markers, not SSE — §11.
- [x] session reuse: per-request in reference; ours is an extension — §15.
- [x] search default: reference ON, ours OFF (recommended) — §12.
- [x] model_type values & limits — §5, §6.
- [ ] `stop_stream` teardown — non-blocking, P2.
- [ ] `favicon`/`reset` semantics (Web/JS reset screen ids) — INFERRED, check against a real capture before relying.
- [ ] test-time confirmation of the last `data.status == "done"` framing on a wide sample — marked [OBSERVED with doubt].
- [ ] `input_exceeds_max_length` hint (error hint from server for oversized requests) — REF-DERIVED existence; exact trigger => verify.