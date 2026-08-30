vim.opt.runtimepath:append(vim.env.FP_NVIM)
-- Hostile options: the opposite of what the layout wants, both ways.
vim.o.splitright = false
vim.o.splitbelow = false
require('flurryport').setup({ presence_interval = 0 })

local ui = require('flurryport.ui')
ui.open(function() end)

local function pos(win) local p = vim.api.nvim_win_get_position(win) return p[1], p[2] end
local frow, fcol = pos(ui.win.feed)
local prow, pcol = pos(ui.win.presence)
local qrow, _ = pos(ui.win.prompt)
print(('feed     row=%d col=%d'):format(frow, fcol))
print(('presence row=%d col=%d'):format(prow, pcol))
print(('prompt   row=%d'):format(qrow))
assert(pcol > fcol, 'presence must be RIGHT of the feed, got feed col ' .. fcol .. ' presence col ' .. pcol)
assert(qrow > frow, 'prompt must be BELOW the feed')
-- #260: the panel sizes to content. Freshly open, the roster is empty, so it
-- sits at the floor: the width of the empty-roster line. And it stays PINNED,
-- so window equalization cannot undo the fit.
local render = require('flurryport.render')
local floor = vim.fn.strdisplaywidth(render.EMPTY_ROSTER)
assert(vim.api.nvim_win_get_width(ui.win.presence) == floor,
  'presence width should sit at the floor, got ' .. vim.api.nvim_win_get_width(ui.win.presence))
assert(vim.wo[ui.win.presence].winfixwidth, 'presence width not pinned')
print('LAYOUT OK')
