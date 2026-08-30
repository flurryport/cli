vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport'); local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

assert(ui.yank_pass() == nil, 'claimed a pass before any mint')

ui.push({ type = 'pairing', code = '7WHM-KR4P-XT2B',
  chairLines = { 'seat minted for Bunny' },
  passLines = { 'You have a seat.', 'Your pairing code is 7WHM-KR4P-XT2B.' } })

local code = ui.yank_pass()
assert(code == '7WHM-KR4P-XT2B', 'wrong code: ' .. tostring(code))
local reg = vim.fn.getreg('"')
assert(reg:find('7WHM%-KR4P%-XT2B'), 'the pass did not reach the unnamed register')
assert(reg:find('You have a seat'), 'only the code was yanked, not the pass text')

-- Yanking must NOT move the cursor: that is the whole point.
local before = vim.api.nvim_win_get_cursor(ui.win.feed)[1]
ui.yank_pass()
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == before, 'yanking moved the cursor')

-- And following survives it, unlike going to look for the pass by hand.
local n = vim.api.nvim_buf_line_count(ui.buf.feed)
ui.push({ type = 'info', text = 'later' })
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] > n - 1, 'stopped following after a yank')
print('PASS OK')
