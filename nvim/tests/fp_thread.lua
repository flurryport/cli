vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport'); local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local function post(byline, text, mine)
  ui.push({ type = 'feed', item = { at = '2026-08-15T18:00:00Z', id = 'x', byline = byline,
    color = nil, channel = 'room', to = nil, text = text, mine = mine or false, tags = {} } })
end
post('director', 'everyone: status?', true)
post('bunny', 'bunny here', false)
post('Frank Ltd (frank)', 'frank here', false)
post('bunny', 'bunny again', false)

ui.set_presence({ { handle = 'bunny', state = 'live' }, { handle = 'frank', state = 'live' } })

-- The first row is the discoverable full-roster action; seats follow it.
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { 2, 0 })
assert(ui.handle_under_cursor() == 'bunny', 'wrong handle under cursor')
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)

local text = table.concat(vim.api.nvim_buf_get_lines(ui.buf.envoys['bunny'], 0, -1, false), '\n')
assert(text:find('bunny and the chair'), 'no thread header: ' .. text:sub(1, 80))
assert(text:find('bunny here') and text:find('bunny again'), 'missing the seat\'s own posts')
assert(text:find('everyone: status%?'), 'the CHAIR was filtered out - the thread has no questions')
assert(not text:find('frank here'), 'another seat leaked into the thread')

-- Line 3 is frank, and "Frank Ltd (frank)" must match the handle.
vim.api.nvim_win_set_cursor(ui.win.presence, { 3, 0 })
assert(ui.handle_under_cursor() == 'frank')
ui.open_envoy('frank')
local ftext = table.concat(vim.api.nvim_buf_get_lines(ui.buf.envoys['frank'], 0, -1, false), '\n')
assert(ftext:find('frank here'), 'the "Guest Name (handle)" byline form did not match')
assert(ftext:find('everyone: status%?'), 'chair missing from frank thread')
assert(not ftext:find('bunny here'), 'bunny leaked into frank thread')

-- Live posts join an OPEN thread only when they belong to it.
post('bunny', 'later from bunny', false)
post('Frank Ltd (frank)', 'later from frank', false)
local btext = table.concat(vim.api.nvim_buf_get_lines(ui.buf.envoys['bunny'], 0, -1, false), '\n')
assert(btext:find('later from bunny'), 'live post did not join the open thread')
assert(not btext:find('later from frank'), 'a live post leaked across threads')

-- #261: q in a THREAD returns to the live feed; it must not close the room.
ui.open_envoy('bunny')
vim.api.nvim_set_current_win(ui.win.feed)
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.envoys['bunny'], 'thread not showing')
vim.api.nvim_feedkeys('q', 'x', false)
assert(ui.is_open(), 'q in a thread tore down the whole room')
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'q in a thread did not return to the feed')
-- back at live: parked on the newest line, following again
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == vim.api.nvim_buf_line_count(ui.buf.feed),
  'q did not land back on the newest line')

-- #276: Enter on `all` is q-in-thread's discoverable twin.
ui.open_envoy('bunny')
vim.api.nvim_set_current_win(ui.win.presence)
vim.api.nvim_win_set_cursor(ui.win.presence, { 1, 0 })
assert(ui.handle_under_cursor() == 'all', 'full-roster row is not first')
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(vim.api.nvim_win_get_buf(ui.win.feed) == ui.buf.feed, 'all did not return to the full feed')

-- On the full feed the action is deliberately a no-op.
local feed_buf = vim.api.nvim_win_get_buf(ui.win.feed)
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'x', false)
assert(vim.api.nvim_win_get_buf(ui.win.feed) == feed_buf, 'all changed an already-full feed')
assert(vim.api.nvim_win_get_cursor(ui.win.feed)[1] == vim.api.nvim_buf_line_count(ui.buf.feed),
  'all did not keep the full feed on its newest line')

-- q in the FEED still closes the room (the escape hatch is untouched one level up).
vim.api.nvim_set_current_win(ui.win.feed)
vim.api.nvim_feedkeys('q', 'x', false)
assert(not ui.is_open(), 'q in the feed no longer closes the room')
print('THREAD OK')
