-- #280b: the status ticker in the feed. A pure fp:status transition renders as
-- ONE dim line (the same dim the system lines wear); a consecutive same-seat
-- same-state repeat collapses to nothing; a ticker riding a content post keeps
-- the message and replaces the key: value stanza dump with the one-liner. The
-- engine decides pure/repeated - this renderer only obeys the item shape.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
local render = require('flurryport.render')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local function item(over)
  local base = { at = '2026-08-15T18:00:00Z', id = 'ticker1', byline = 'bunny', color = 'red',
    channel = 'room', to = nil, text = '', mine = false,
    verb = { raw = 'fp:status', display = 'status', recipe = false, args = {} },
    re = nil, panic = false, status = { state = 'working' }, tags = {} }
  for k, v in pairs(over) do base[k] = v end
  return base
end

-- Pure transition: one dim line carrying seat, state, and the detail.
local pure = render.event({ type = 'feed', item = item({
  statusTicker = { state = 'working', detail = 'compiling', pure = true, repeated = false } }) })
assert(#pure == 1, 'a pure ticker is one line, got ' .. #pure)
assert(pure[1].text:find('bunny', 1, true), 'the ticker names the seat: ' .. pure[1].text)
assert(pure[1].text:find('working: compiling', 1, true), 'state and detail ride the line: ' .. pure[1].text)
assert(pure[1].hls[1].group == 'FlurryPortDim', 'the ticker wears the system dim')

local blocked = render.event({ type = 'feed', item = item({
  status = { state = 'blocked-on-human', reason = 'permission needed' },
  statusTicker = { state = 'blocked-on-human', detail = 'permission needed', pure = true, repeated = false } }) })
assert(blocked[1].hls[1].group == 'FlurryPortError', 'blocked-on-human rings red')

-- A consecutive repeat collapses to nothing at all.
local collapsed = render.event({ type = 'feed', item = item({
  statusTicker = { state = 'working', detail = nil, pure = true, repeated = true } }) })
assert(#collapsed == 0, 'a repeated pure ticker adds no lines, got ' .. #collapsed)

-- Riding a content post: meta + body + the one-liner replaces the stanza dump.
local riding = render.event({ type = 'feed', item = item({ text = 'found the bug', verb = nil,
  status = { state = 'review', reason = 'diff up', tests = '12/12' },
  statusTicker = { state = 'review', detail = 'diff up', pure = false, repeated = false } }) })
assert(#riding == 3, 'meta + body + ticker, got ' .. #riding)
assert(riding[3].text == render.INDENT .. render.INDENT .. 'review: diff up',
  'the ticker line replaces the stanza dump: ' .. riding[3].text)
assert(riding[3].hls[1].group == 'FlurryPortDim', 'the riding ticker is dim too')

-- A repeat on a content post drops only the ticker line; the message stays.
local msg_only = render.event({ type = 'feed', item = item({ text = 'more words', verb = nil,
  status = { state = 'review' },
  statusTicker = { state = 'review', detail = nil, pure = false, repeated = true } }) })
assert(#msg_only == 2, 'a repeat drops only the ticker line, got ' .. #msg_only)

-- No protocol state, no ticker: the generic key: value stanza stands untouched.
local generic = render.event({ type = 'feed', item = item({ text = 'hi', verb = nil,
  status = { task = 'warming up' }, statusTicker = nil }) })
assert(#generic == 3, 'stanza rendering unchanged, got ' .. #generic)
assert(generic[3].text:find('task: warming up', 1, true), 'the generic stanza line stands: ' .. generic[3].text)

print('TICKER OK')
