-- #499 gaps 9 to 11, 13, 14 (built on Gene's word 2026-09-23): the arm from the
-- feed. Enter or a double-click on a post arms it; the next PLAIN lines answer
-- it (re) and, through the engine, address its author (to); the arm HOLDS
-- across lines (sticky: prose does not disarm, so the chair writes on both
-- sides of a gavel); :none drops it; a post arm ignores disposition echoes;
-- the header shows [for section]; the review verdicts act on the arm; :for
-- files the reply; :help carries the editor's keys.
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

local function post(o)
  local item = {
    at = '2026-09-23T15:00:00Z', id = o.id, byline = o.byline, color = nil, channel = o.to and 'mention' or 'room',
    to = o.to, text = o.text, re = o.re, mine = o.mine or false, tags = {}, from = o.from, verb = o.verb,
  }
  item['for'] = o.section
  ui.push({ type = 'feed', item = item })
end

-- ── the header shows [for section] (#499 gap 13) ─────────────────────────────
post({ id = 'writ0001AAAA', byline = 'unsigned', from = 'writer', section = 'tagline', text = 'draft two:\nHands and receipts.' })
post({ id = 'gene0001AAAA', byline = 'gene', from = 'gene', text = 'noted', mine = true })
post({ id = 'revw0001AAAA', byline = 'unsigned', from = 'reviewer', text = 'proceed', re = 'writ0001AAAA' })
local feed = vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false)
local text = table.concat(feed, '\n')
assert(text:find('[for tagline]', 1, true), 'the header must show the section: ' .. feed[1])
assert(text:find('draft two:', 1, true) and text:find('Hands and receipts.', 1, true), 'the multi-line body renders')

-- ── the line map: every row of a post maps back to it ────────────────────────
local header_row, body_row
for i, l in ipairs(feed) do
  if l:find('writ00', 1, true) and not header_row then header_row = i end
  if l:find('Hands and receipts', 1, true) then body_row = i end
end
assert(header_row and body_row and body_row > header_row, 'could not locate the first post')
assert(ui.feed_rows[header_row] and ui.feed_rows[header_row].id == 'writ0001AAAA', 'the header row maps to its post')
assert(ui.feed_rows[body_row] and ui.feed_rows[body_row].id == 'writ0001AAAA', 'a wrapped body row maps to the same post')

-- ── Enter on the header arms the post (#499 gap 9) ───────────────────────────
vim.api.nvim_set_current_win(ui.win.feed)
vim.api.nvim_win_set_cursor(ui.win.feed, { header_row, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed and ui.armed.kind == 'post', 'Enter on a post header did not arm it')
assert(ui.armed.ref == 'writ0001', 'the ref is the first 8 characters of the id')
assert(ui.armed.to == 'writer', 'the arm carries the author for the marker')
assert(ui.armed.unsigned == true, 'the unsigned mark rides the arm')

-- The marker names the ref, the author, and the unsigned mark (#499 gap 10).
local marks = vim.api.nvim_buf_get_extmarks(ui.buf.prompt, ui.ns, 0, -1, { details = true })
assert(#marks > 0, 'no marker on the prompt')
local virt = marks[1][4].virt_text[1][1]
assert(virt == '[re writ0001 to writer, unsigned]', 'marker text: ' .. virt)

-- ── sticky (#499 gap 11): plain lines re-link and the arm HOLDS ──────────────
assert(ui.route_line('tighter please') == ':re writ0001 tighter please', 'the plain line must re-link')
assert(ui.armed and ui.armed.ref == 'writ0001', 'prose must not disarm')
assert(ui.route_line('and drop the colon') == ':re writ0001 and drop the colon', 'the second line re-links too')
assert(ui.armed, 'still armed after two lines')

-- Both sides of a gavel on one arm: prose, the gavel, prose.
assert(ui.route_line(':ratify') == ':ratify writ0001', 'bare :ratify acts on the armed post')
assert(ui.armed, 'the gavel keeps the arm')
assert(ui.route_line('so ruled, thank you') == ':re writ0001 so ruled, thank you', 'prose after the gavel still re-links')

-- A post arm ignores the disposition echo (a decision arm still drops on it).
ui.push({ type = 'feed', item = { at = '2026-09-23T15:05:00Z', id = 'rule0001AAAA', byline = 'gene', mine = true,
  color = nil, channel = 'room', to = nil, text = '', re = 'writ0001AAAA', tags = {},
  verb = { raw = 'fp:ratify', display = 'ratify', recipe = false, args = {} } } })
assert(ui.armed and ui.armed.ref == 'writ0001', 'the fp:ratify echo must not clear a POST arm')

-- ── the review verdicts act on the arm; a leading reference passes through ───
assert(ui.route_line(':proceed') == ':proceed writ0001', 'bare :proceed reviews the armed post')
assert(ui.route_line(':finding the colon is back') == ':finding writ0001 the colon is back', 'prose rides after the ref')
assert(ui.route_line(':hold') == ':hold writ0001', 'bare :hold is the review on the arm')
assert(ui.route_line(':proceed gene0001 fine') == ':proceed gene0001 fine', 'an explicit reference passes through untouched')
assert(ui.route_line(':satisfied writ0001AAAA') == ':satisfied writ0001AAAA', 'the full id passes through too')

-- ── :for with an arm files the reply for a section (#499 gap 2) ──────────────
assert(ui.route_line(':for tagline shorter') == ':for tagline :re writ0001 shorter', ':for text must answer the armed post')
assert(ui.route_line(':for tagline :writer redo') == ':for tagline :writer redo', 'a : led tail is left as typed')

-- Other verb lines pass through and keep the arm.
assert(ui.route_line(':list seats') == ':list seats')
assert(ui.armed, 'a verb line keeps the arm')

-- ── :none drops the arm and sends nothing ────────────────────────────────────
assert(ui.route_line(':none') == '', ':none must send nothing')
assert(ui.armed == nil, ':none did not disarm')
assert(ui.route_line('plain again') == 'plain again', 'a dropped arm posts un-linked')
-- Unarmed, :none reaches the engine (which only teaches).
assert(ui.route_line(':none') == ':none', 'unarmed, :none passes through to the engine hint')

-- ── arming the chair's own post addresses nobody ─────────────────────────────
local mine_row
feed = vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false)
for i, l in ipairs(feed) do
  if l:find('gene00', 1, true) then mine_row = i end
end
vim.api.nvim_win_set_cursor(ui.win.feed, { mine_row, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed and ui.armed.ref == 'gene0001', 'Enter on the chair post did not arm it')
assert(ui.armed.to == nil, 'the chair post carries no addressee')
assert(ui.armed.unsigned == false, 'a signed post is not marked unsigned')
marks = vim.api.nvim_buf_get_extmarks(ui.buf.prompt, ui.ns, 0, -1, { details = true })
assert(marks[1][4].virt_text[1][1] == '[re gene0001]', 'marker on the chair post: ' .. marks[1][4].virt_text[1][1])

-- ── one selection: a post arm and a decision arm replace each other ──────────
ui.set_decisions({ { id = 'writ0001AAAA', ref = 'writ0001', state = 'needs-ratification', summary = 'draft two', ratifiedBy = vim.NIL, verdict = 'proceed' } })
local dec_line
for i, row in ipairs(ui.presence_rows) do
  if row.decision then dec_line = i end
end
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { dec_line, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed and ui.armed.kind == 'decision' and ui.armed.ref == 'writ0001', 'the decision row did not replace the post arm')
-- The verdict marker (#499 gap 5): a pending row with a proceed wears >.
local panel = table.concat(vim.api.nvim_buf_get_lines(ui.buf.presence, 0, -1, false), '\n')
assert(panel:find('> draft two', 1, true), 'a reviewed pending row must wear the > marker: ' .. panel)
ui.show_feed()
assert(ui.armed == nil, 'back to live disarms')
vim.api.nvim_set_current_win(ui.win.feed)
vim.api.nvim_win_set_cursor(ui.win.feed, { header_row, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(ui.armed and ui.armed.kind == 'post', 'a post arm after a decision arm')

-- ── repaint rebuilds the line map ────────────────────────────────────────────
render.color_bodies = not render.color_bodies
ui.repaint()
feed = vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false)
for i, l in ipairs(feed) do
  if l:find('Hands and receipts', 1, true) then body_row = i end
end
assert(ui.feed_rows[body_row] and ui.feed_rows[body_row].id == 'writ0001AAAA', 'repaint lost the line map')

-- ── the editor keys ride the full :help listing (#499 gap 14) ─────────────────
fp.handle_event({ type = 'help', lines = { 'Console commands. Bare text posts to the room. : is the only mode shift.', '', 'Context', '  :list projects' } })
feed = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
assert(feed:find('Editor keys (nvim)', 1, true), 'the full listing must carry the editor keys')
assert(feed:find('Enter or double-click on a post', 1, true), 'the arm key is documented')
fp.handle_event({ type = 'help', lines = { ':ratify [handle|ref] gavels.' } })
feed = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
local _, keys_count = feed:gsub('Editor keys %(nvim%)', '')
assert(keys_count == 1, 'a single-verb help answer must not repeat the keys')

-- ── a view event paints a title and dim rows ─────────────────────────────────
ui.push({ type = 'view', title = 'What stands:', lines = { '  tagline  [rule0001]', '    Webhooks with receipts.' } })
feed = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
assert(feed:find('What stands:', 1, true) and feed:find('Webhooks with receipts.', 1, true), 'the view did not render')

print('fp_arm OK')
