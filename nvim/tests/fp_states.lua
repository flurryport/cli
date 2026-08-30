-- #266: the presence strip renders the four transport states (live / idle /
-- adrift / departed) plus the held overlay, and #267's grey mutes the handle on
-- post-mortem rows. vim.NIL is TRUTHY in Lua, so a JSON-null presence must be
-- normalized, not branched on - the classic trap, proven here.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
local render = require('flurryport.render')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local roster = { type = 'roster', rows = {
  { handle = 'alpha', guestName = 'alpha', status = 'accepted', live = true, held = false, greyed = false, presence = 'live', color = 'cyan' },
  { handle = 'beta', guestName = 'beta', status = 'accepted', live = true, held = false, greyed = false, presence = 'idle', color = 'red' },
  { handle = 'gamma', guestName = 'gamma', status = 'accepted', live = true, held = false, greyed = false, presence = 'adrift', color = 'green' },
  { handle = 'delta', guestName = 'delta', status = 'accepted', live = true, held = false, greyed = true, presence = 'departed', color = 'blue' },
  { handle = 'ghost', guestName = 'ghost', status = 'revoked', live = false, held = false, greyed = true, presence = vim.NIL, color = 'yellow' },
  { handle = 'busy', guestName = 'busy', status = 'accepted', live = true, held = true, greyed = false, presence = 'live', color = 'magenta' },
} }
fp.handle_event(roster)
local rows = ui.presence_rows
assert(#rows == 7, 'full-roster action plus every roster row must reach the strip')
assert(rows[1].handle == 'all' and rows[1].full_roster, 'full-roster action must lead the strip')
assert(rows[2].state == 'live', 'live passes through')
assert(rows[3].state == 'idle', 'idle passes through')
assert(rows[4].state == 'adrift', 'adrift passes through')
assert(rows[5].state == 'departed', 'departed passes through')
assert(rows[6].state == 'revoked', 'vim.NIL presence must not win: got ' .. tostring(rows[6].state))
assert(rows[7].state == 'held', 'held overlays transport truth, as the console does')

local seat_rows = {}
for i = 2, #rows do table.insert(seat_rows, rows[i]) end
local lines = render.presence(seat_rows)
local function state_hl(i) return lines[i].hls[2].group end
assert(state_hl(2) == 'FlurryPortGreen', 'live is green')
assert(state_hl(3) == 'FlurryPortYellow', 'idle is yellow: seated, not attending')
assert(state_hl(4) == 'FlurryPortDim', 'adrift is dim')
assert(state_hl(5) == 'FlurryPortGray', 'departed is gray')
assert(state_hl(7) == 'FlurryPortYellow', 'held keeps its yellow')

-- The grey mutes the HANDLE on post-mortem rows; living handles keep seat colour.
assert(lines[2].hls[1].group == 'FlurryPortCyan', 'a live handle keeps its seat colour')
assert(lines[5].hls[1].group == 'FlurryPortGray', 'a departed handle greys')
assert(lines[6].hls[1].group == 'FlurryPortGray', 'a revoked handle greys')

print('STATES OK')
