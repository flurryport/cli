-- #295: the decisions panel. A section under the seat rows in the presence
-- panel: five-word entries, state markers, struck omitted. Enter on a row opens
-- the decision's THREAD in the feed window (the #276 seat-thread mechanics) and
-- ARMS it as the chair's one-shot reply target; selecting all or any seat, or
-- going back to live, disarms (Gene's ruling verbatim).
vim.opt.runtimepath:append(vim.env.FP_NVIM)
vim.o.columns = 150
local fp = require('flurryport')
local ui = require('flurryport.ui')
local render = require('flurryport.render')
fp.setup({ presence_interval = 0 })
local sent = {}
ui.open(function(line)
  table.insert(sent, line)
end)

-- ── the five-word cap (ruled: three to five words max, no ellipsis) ──────────
assert(render.decision_words('open the gate at dawn tomorrow morning sharp') == 'open the gate at dawn',
  'an eight-word summary must cut to its first five words')
assert(render.decision_words('cast swap stands') == 'cast swap stands', 'a short summary rides whole')
assert(not render.decision_words('one two three four five six'):find('%.%.%.'), 'no ellipsis rows')

-- ── the section: markers, dimming, struck omitted ────────────────────────────
local decisions = {
  { id = 'prop0001AAAA', ref = 'prop0001', state = 'needs-ratification',
    summary = 'open the gate at dawn tomorrow morning sharp', ratifiedBy = vim.NIL },
  { id = 'prop0002BBBB', ref = 'prop0002', state = 'ratified',
    summary = 'the closer goes echoless', ratifiedBy = 'rule0001',
    settledAt = os.date('!%Y-%m-%dT%H:%M:%SZ', os.time()) },
  { id = 'prop0003CCCC', ref = 'prop0003', state = 'retracted',
    summary = 'cast swap stands', ratifiedBy = vim.NIL,
    settledAt = os.date('!%Y-%m-%dT%H:%M:%SZ', os.time() - 301) },
  { id = 'prop0004EEEE', ref = 'prop0004', state = 'struck',
    summary = 'never speak of this', ratifiedBy = vim.NIL },
}
ui.set_presence({ { handle = 'fable', state = 'live' }, { handle = 'codex', state = 'live' } })
ui.set_decisions(decisions)

local lines = vim.api.nvim_buf_get_lines(ui.buf.presence, 0, -1, false)
local text = table.concat(lines, '\n')
assert(text:find('decisions', 1, true), 'no section header')
assert(text:find('? open the gate at dawn', 1, true), 'pending row: ? marker plus first five words')
assert(not text:find('tomorrow'), 'the five-word cap leaked a sixth word into the panel')
assert(text:find('%* the closer goes echoless'), 'ratified row wears *')
assert(not text:find('~ cast swap stands', 1, true), 'settled rows fade after five minutes')
assert(not text:find('never speak'), 'struck rows are omitted from the panel')

-- The cursor map: below the seats, decision lines map back to their decision.
local pending_line, ratified_line, seat_line, all_line
for i, row in ipairs(ui.presence_rows) do
  if row.decision and row.decision.ref == 'prop0001' then pending_line = i end
  if row.decision and row.decision.ref == 'prop0002' then ratified_line = i end
  if row.handle == 'fable' then seat_line = i end
  if row.full_roster then all_line = i end
end
assert(pending_line and ratified_line and seat_line and all_line, 'cursor map incomplete')
assert(lines[pending_line]:find('open the gate', 1, true), 'presence_rows drifted off the painted lines')

-- ── the thread: proposal plus everything re-linked, chronological ────────────
local function post(id, byline, text_, re, mine)
  ui.push({ type = 'feed', item = { at = '2026-08-17T18:00:00Z', id = id, byline = byline,
    color = nil, channel = 'room', to = nil, text = text_, re = re, mine = mine or false, tags = {} } })
end
post('prop0001AAAA', 'fable', 'we should open the gate at dawn', nil)
post('repl0001AAAA', 'director', 'which dawn exactly', 'prop0001AAAA', true)
post('rule0001AAAA', 'director', 'so ruled', 'prop0001', true) -- the 8 character re form resolves too
post('noise001AAAA', 'codex', 'unrelated chatter', nil)

vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { pending_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)

local dbuf = ui.buf.decisions['prop0001AAAA']
assert(dbuf and vim.api.nvim_win_get_buf(ui.win.feed) == dbuf, 'Enter did not open the decision thread')
local dtext = table.concat(vim.api.nvim_buf_get_lines(dbuf, 0, -1, false), '\n')
assert(dtext:find('decision prop0001', 1, true), 'no thread header')
assert(dtext:find('we should open the gate', 1, true), 'the proposal post is missing')
assert(dtext:find('which dawn exactly', 1, true), 'a re-linked reply is missing')
assert(dtext:find('so ruled', 1, true), 'a short-reference re-link did not resolve')
assert(not dtext:find('unrelated chatter'), 'an unrelated post leaked into the thread')

-- A live re-linked row joins the OPEN thread; unrelated rows stay out.
post('late0001AAAA', 'fable', 'late addendum', 'prop0001AAAA')
post('noise002AAAA', 'codex', 'more chatter', nil)
dtext = table.concat(vim.api.nvim_buf_get_lines(dbuf, 0, -1, false), '\n')
assert(dtext:find('late addendum', 1, true), 'live re-linked post did not join the thread')
assert(not dtext:find('more chatter'), 'a live unrelated post leaked in')

-- ── arming: one shot, verb lines exempt, answers exempt ──────────────────────
assert(ui.armed and ui.armed.ref == 'prop0001', 'selection did not arm the decision')
assert(ui.route_line(':list seats') == ':list seats', 'a verb line must pass through untouched')
assert(ui.armed, 'a verb line must not consume the armed target')
assert(ui.route_line('sounds right, so ruled') == ':re prop0001 sounds right, so ruled',
  'the next plain message must post re-linked to the armed decision')
assert(ui.armed == nil, 'one shot: the armed target must clear after the send')
assert(ui.route_line('a second message') == 'a second message', 'the shot already fired')

-- An engine question owns the next line: the answer is never a reply.
ui.open_decision(decisions[1])
ui.push({ type = 'confirm', text = 'Revoke fable? y/N' })
assert(ui.armed and ui.armed.ref == 'prop0001', 'a question must not silently disarm')
assert(ui.route_line('y') == 'y', 'the answer line went to the armed target instead of the question')
assert(ui.armed, 'answering a question must keep the armed target')

-- Selecting another decision re-arms; whichever was selected last wins.
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { ratified_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed and ui.armed.ref == 'prop0002', 'the later selection did not win')

-- ── Gene's ruling verbatim: all, or any actor, unselects the decision ────────
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { all_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed == nil, 'selecting all did not unselect the decision')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'all did not return to the live feed')
assert(ui.route_line('plain again') == 'plain again', 'a disarmed prompt must post un-linked')

ui.open_decision(decisions[1])
assert(ui.armed, 're-arm for the seat-row half')
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { seat_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed == nil, 'selecting a seat did not unselect the decision')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.envoys['fable'], 'the seat row lost its thread behavior')

-- Back to live disarms too, and q in a decision thread IS back to live.
ui.open_decision(decisions[1])
assert(ui.armed, 're-arm for the back-to-live half')
vim.api.nvim_set_current_win(ui.win.feed)
vim.api.nvim_feedkeys('q', 'x', false)
assert(ui.is_open(), 'q in a decision thread tore down the room')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'q did not return to the live feed')
assert(ui.armed == nil, 'back to live did not disarm')

-- ── the clear row (#295, Gene's order): none leads the section ───────────────
local none_line
for i, row in ipairs(ui.presence_rows) do
  if row.decision_clear then none_line = i end
end
assert(none_line, 'no clear row in the cursor map')
local panel = vim.api.nvim_buf_get_lines(ui.buf.presence, 0, -1, false)
assert(panel[none_line] == '  none', 'the clear row must render as a plain none entry')
assert(panel[none_line - 1]:find('decisions', 1, true), 'the clear row must lead the section, right under the header')

-- Enter on none: the armed decision drops, the decision thread returns to
-- live (the #276 contract), and the next plain message posts un-linked.
ui.open_decision(decisions[1])
assert(ui.armed, 're-arm for the clear row')
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { none_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed == nil, 'the clear row did not disarm')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'the clear row did not return the decision thread to live')
assert(ui.route_line('plain after none') == 'plain after none', 'the next message must post without re')

-- A seat thread is not a decision selection: none leaves it alone.
ui.open_envoy('fable')
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { none_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.envoys['fable'], 'the clear row must not yank a seat thread')
ui.show_feed()

-- An empty ledger drops the whole section (the bind reset path).
ui.set_decisions({})
local reset = table.concat(vim.api.nvim_buf_get_lines(ui.buf.presence, 0, -1, false), '\n')
assert(not reset:find('decisions', 1, true), 'an empty ledger must drop the section')
assert(not reset:find('none', 1, true), 'the clear row must drop with the section')

-- ── selection-aware record verbs (#295, ratified): bare :ratify gavels the armed decision ──
ui.open_decision(decisions[1])
assert(ui.armed and ui.armed.ref == 'prop0001', 're-arm for the record verbs')
assert(ui.route_line(':ratify') == ':ratify prop0001', 'bare :ratify must rewrite to the explicit-ref form')
assert(ui.armed, 'the selection holds until the disposition echoes off the log')
assert(ui.route_line(':retract') == ':retract prop0001', 'bare :retract must null the armed decision')
assert(ui.route_line(':ratify prop0002') == ':ratify prop0002', 'an explicit ref passes through untouched')
assert(ui.route_line(':list decisions') == ':list decisions', 'other verb lines still pass through')

-- The disposition echo clears the selection (#295, word-ratified): the act
-- landing on the log re-linked to the armed decision drops the marker, same as
-- the none row, and returns the decision thread to live. Plain traffic never
-- clears; the echo is the went-through signal.
post('noise003AAAA', 'codex', 'chatter between acts', nil)
assert(ui.armed, 'plain traffic must not clear the selection')
ui.push({ type = 'feed', item = { at = '2026-08-17T18:05:00Z', id = 'rule0002AAAA', byline = 'director',
  color = nil, channel = 'room', to = nil, text = '', re = 'prop0001',
  verb = { raw = 'fp:ratify', display = 'ratify', recipe = false, args = {} },
  mine = true, tags = {} } })
assert(ui.armed == nil, 'the fp:ratify echo did not clear the selection')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed,
  'the disposition did not return the decision thread to live')
assert(ui.route_line(':ratify') == ':ratify',
  'unarmed, bare :ratify passes through: the ratify-all prompt is only ever the unarmed path')

-- fp:strike clears the same way; a disposition against a DIFFERENT decision
-- leaves the selection alone.
ui.open_decision(decisions[1])
ui.push({ type = 'feed', item = { at = '2026-08-17T18:06:00Z', id = 'retr0001AAAA', byline = 'director',
  color = nil, channel = 'room', to = nil, text = '', re = 'prop0002BBBB',
  verb = { raw = 'fp:retract', display = 'retract', recipe = false, args = {} },
  mine = true, tags = {} } })
assert(ui.armed and ui.armed.ref == 'prop0001', 'a disposition against another decision must not clear the selection')
ui.push({ type = 'feed', item = { at = '2026-08-17T18:07:00Z', id = 'strk0001AAAA', byline = 'director',
  color = nil, channel = 'room', to = nil, text = '', re = 'prop0001AAAA',
  verb = { raw = 'fp:strike', display = 'strike', recipe = false, args = {} },
  mine = true, tags = {} } })
assert(ui.armed == nil, 'the fp:strike echo did not clear the selection')

-- fp:retract against the armed decision clears too.
ui.open_decision(decisions[1])
ui.push({ type = 'feed', item = { at = '2026-08-17T18:08:00Z', id = 'retr0002AAAA', byline = 'director',
  color = nil, channel = 'room', to = nil, text = '', re = 'prop0001AAAA',
  verb = { raw = 'fp:retract', display = 'retract', recipe = false, args = {} },
  mine = true, tags = {} } })
assert(ui.armed == nil, 'the fp:retract echo did not clear the selection')
ui.show_feed()

-- The word gavel rides the existing armed one-shot: the exact word routes as
-- the explicit reply form, and the ENGINE reads the word as the act.
ui.open_decision(decisions[1])
assert(ui.route_line('Ratified') == ':re prop0001 Ratified',
  'the word routes as :re <ref> <text> for the engine to gavel')
assert(ui.armed == nil, 'the one shot fired')

print('DECISIONS OK')
