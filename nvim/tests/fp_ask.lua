-- #262: a question never renders invisibly. An ask/confirm forces the feed
-- window back to the live feed before painting, and a pending-answer marker
-- rides the prompt until the next line is submitted.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local function post(byline, text, mine)
  ui.push({ type = 'feed', item = { at = '2026-08-15T18:00:00Z', id = 'q1', byline = byline,
    color = nil, channel = 'room', to = nil, text = text, mine = mine or false, tags = {} } })
end
post('bunny', 'bunny here', false)
post('director', 'noted', true)

--- The prompt buffer's pending markers.
local function markers()
  return vim.api.nvim_buf_get_extmarks(ui.buf.prompt, ui.ns, 0, -1, { details = true })
end

-- 1. a confirm arriving while a THREAD is on screen forces the live feed back
ui.open_envoy('bunny')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.envoys['bunny'], 'thread not showing')
ui.push({ type = 'confirm', text = 'Revoke bunny? y/N' })
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'the question painted into a hidden buffer')
local feed = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
assert(feed:find('Revoke bunny%? y/N'), 'the question is not in the feed')
-- and the reader is parked where the question is
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == vim.api.nvim_buf_line_count(ui.buf.feed),
  'the question rendered off screen')

-- 2. the prompt carries a visible y/N marker while the answer is owed
local marks = markers()
assert(#marks == 1, 'expected one pending marker, got ' .. #marks)
assert(marks[1][4].virt_text[1][1] == '[y/N waiting]', 'wrong marker: ' .. marks[1][4].virt_text[1][1])

-- 3. submitting the answer clears the marker
vim.api.nvim_set_current_win(ui.win.prompt)
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('Ay<CR>', true, false, true), 'x', false)
assert(#markers() == 0, 'the marker outlived its answer')

-- 4. an ask wears its own marker, and a re-ask after the answer re-pins it
ui.push({ type = 'ask', text = 'Choose your address on the wire.' })
local m = markers()
assert(#m == 1 and m[1][4].virt_text[1][1] == '[answer waiting]', 'ask marker missing')
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('Adirector<CR>', true, false, true), 'x', false)
assert(#markers() == 0, 'the ask marker outlived its answer')
ui.push({ type = 'ask', text = 'That name is reserved. Pick another.' })
assert(#markers() == 1, 'a re-ask did not re-pin the marker')

print('ASK OK')
