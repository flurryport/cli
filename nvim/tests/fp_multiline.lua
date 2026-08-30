vim.opt.runtimepath:append(vim.env.FP_NVIM)
require('flurryport').setup({ presence_interval = 0 })

local ui = require('flurryport.ui')
ui.open(function() end)

-- Found live (#281 drive): the record picker's queue listing arrives as ONE
-- info event whose text carries embedded newlines, and nvim_buf_set_lines
-- refuses items containing newlines - the feed write crashed and the picker
-- never rendered. The write path must flatten multi-line text into rows.
local ok, err = pcall(ui.push, {
  type = 'info',
  text = 'Pending ratifications:\n  1. [abcd1234] first summary\n  2. [ef567890] second summary',
})
assert(ok, 'multi-line info crashed the feed write: ' .. tostring(err))

local rows = vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false)
local joined = table.concat(rows, '\029')
assert(joined:find('Pending ratifications:', 1, true), 'first row missing')
assert(joined:find('2. [ef567890] second summary', 1, true), 'last row missing')
for _, row in ipairs(rows) do
  assert(not row:find('\n', 1, true), 'a row still carries a newline')
end

-- The same guarantee holds for feed items: a post text with newlines renders
-- as paragraph rows, never a crash (the pass and proposals both do this).
local ok2, err2 = pcall(ui.push, {
  type = 'feed',
  item = { at = '2026-08-17T20:30:00Z', id = 'x1', byline = 'fable', from = 'fable', text = 'para one\n\npara two' },
})
assert(ok2, 'multi-line feed item crashed the write: ' .. tostring(err2))

print('MULTILINE OK')
