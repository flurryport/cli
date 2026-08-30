-- #260: the presence panel sizes to content. Width fits the longest rendered
-- roster row, floored at the empty-roster line, capped at 40 or a third of the
-- screen, whichever is smaller; handles pad to the longest at the table and the
-- highlight offsets are computed from that pad, never hardcoded.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
vim.o.columns = 150
local fp = require('flurryport')
local ui = require('flurryport.ui')
local render = require('flurryport.render')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local floor = vim.fn.strdisplaywidth(render.EMPTY_ROSTER)

-- 1. an empty roster sits at the floor
ui.set_presence({})
assert(vim.api.nvim_win_get_width(ui.win.presence) == floor,
  'empty roster should sit at the floor, got ' .. vim.api.nvim_win_get_width(ui.win.presence))

-- 2. handles pad to the longest at the table; offsets are computed off that pad
local rows = {
  { handle = 'bo', state = 'live', posts = 2, color = 'cyan' },
  { handle = 'the-tall-bard', state = 'held', posts = 11, color = 'red' },
}
local lines = render.presence(rows)
local state_at = 2 + #'the-tall-bard' + 1
assert(lines[2].text:sub(state_at + 1, state_at + 4) == 'live', 'row 1 state misaligned: ' .. lines[2].text)
assert(lines[3].text:sub(state_at + 1, state_at + 4) == 'held', 'row 2 state misaligned: ' .. lines[3].text)
assert(lines[2].hls[1].from == 2 and lines[2].hls[1].to == 2 + #'bo', 'handle span is off')
assert(lines[2].hls[2].from == state_at and lines[2].hls[2].to == state_at + #'live',
  'state span not computed from the pad')
assert(lines[3].hls[2].from == state_at, 'state spans disagree between rows')

-- 3. the panel grows to fit the longest rendered row (cap is 40 at 150 columns)
ui.set_presence(rows)
local widest = 0
for _, l in ipairs(render.presence(rows)) do
  widest = math.max(widest, vim.fn.strdisplaywidth(l.text))
end
assert(widest > floor, 'fixture too narrow to prove growth')
assert(vim.api.nvim_win_get_width(ui.win.presence) == widest,
  ('panel should fit content: want %d got %d'):format(widest, vim.api.nvim_win_get_width(ui.win.presence)))

-- 4. the cap: an absurd handle stops at min(40, a third of the screen)
local long = { { handle = string.rep('x', 60), state = 'live', posts = 1, color = 'red' } }
ui.set_presence(long)
assert(vim.api.nvim_win_get_width(ui.win.presence) == 40,
  'cap at 150 columns should be 40, got ' .. vim.api.nvim_win_get_width(ui.win.presence))

-- 5. a narrower screen caps at a third of it, even under the floor
vim.o.columns = 60
ui.set_presence(long)
assert(vim.api.nvim_win_get_width(ui.win.presence) == 20,
  'cap at 60 columns should be 20, got ' .. vim.api.nvim_win_get_width(ui.win.presence))
vim.o.columns = 150

-- 6. every repaint recomputes: the panel shrinks back with the roster
ui.set_presence({})
assert(vim.api.nvim_win_get_width(ui.win.presence) == floor, 'the panel did not shrink back')

-- 7. the width stays pinned so equalization cannot undo the fit
assert(vim.wo[ui.win.presence].winfixwidth, 'winfixwidth was lost')

print('PRESENCE OK')
