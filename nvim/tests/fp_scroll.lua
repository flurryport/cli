vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local function push_rows(n)
  local rows = {}
  for i = 1, n do table.insert(rows, { projectSlug = 'p' .. i, slug = 'e' .. i, name = 'n' .. i }) end
  ui.push({ type = 'endpoints', rows = rows })
end

-- A tall write (the exact failure: a ten-row listing) must still follow.
push_rows(10)
local count = vim.api.nvim_buf_line_count(ui.buf.feed)
local cur = vim.api.nvim_win_get_cursor(ui.win.feed)[1]
assert(cur == count, ('did not follow a tall write: cursor %d of %d'):format(cur, count))

-- Several in a row keep following.
push_rows(25)
count = vim.api.nvim_buf_line_count(ui.buf.feed)
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == count, 'stopped following after a second tall write')

-- But a reader scrolled UP is never yanked forward - the whole point of the plugin.
vim.api.nvim_win_set_cursor(ui.win.feed, { 3, 0 })
push_rows(10)
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == 3, 'yanked the reader away from history')

-- :Fl feed always returns to live.
ui.show_feed()
count = vim.api.nvim_buf_line_count(ui.buf.feed)
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == count, 'show_feed did not land on the newest line')
print('SCROLL OK')
