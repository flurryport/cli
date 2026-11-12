-- #499 gap 9: where the console IS. The feed is a scroll of bylines that never
-- repeats the room, so the engine's `room` event paints the feed window's winbar
-- AND renames the feed buffer (every statusline and tabline in the wild prints a
-- buffer name; none of them are ours to control).
vim.opt.runtimepath:append(vim.env.FP_NVIM)
vim.o.columns = 150
local fp = require('flurryport')
local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local function winbar() return vim.wo[ui.win.feed].winbar end
local function bufname() return vim.api.nvim_buf_get_name(ui.buf.feed) end

-- Cold open: no room bound, so nothing is claimed.
assert(winbar() == '', 'a cold feed must wear no winbar, got ' .. vim.inspect(winbar()))
assert(bufname():match('flurryport://feed$'), 'cold buffer name should be the plain feed, got ' .. bufname())

-- Bound: the slug pair first (it is what you type), the display name after.
fp.handle_event({ type = 'room', projectSlug = 'spill-coffee', endpointSlug = 'launch-kit', name = 'Launch kit' })
assert(winbar():find('spill%-coffee/launch%-kit', 1, false), 'winbar must carry the slug pair, got ' .. winbar())
assert(winbar():find('Launch kit', 1, true), 'winbar must carry the display name, got ' .. winbar())
assert(bufname():match('flurryport://spill%-coffee/launch%-kit$'),
  'the feed buffer must be named for the room, got ' .. bufname())

-- A room event is panel state: it must never reach the feed text.
local feed_text = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
assert(not feed_text:find('Launch kit', 1, true), 'the room must not be painted into the feed')

-- Rebinding moves both. The old name must not strand the new one (E95).
fp.handle_event({ type = 'room', projectSlug = 'spill-coffee', endpointSlug = 'strip-room', name = 'Strip room' })
assert(bufname():match('flurryport://spill%-coffee/strip%-room$'), 'rebind must rename, got ' .. bufname())
assert(winbar():find('Strip room', 1, true), 'rebind must repaint the winbar, got ' .. winbar())

-- `%` is winbar syntax. An endpoint named with one must not render half an item.
fp.handle_event({ type = 'room', projectSlug = 'p', endpointSlug = 'e', name = '100% signed' })
assert(winbar():find('100%%%% signed'), 'a percent in the name must be escaped, got ' .. winbar())

-- A room with no display name still says where you are.
fp.handle_event({ type = 'room', projectSlug = 'p', endpointSlug = 'nameless', name = nil })
assert(winbar():find('p/nameless', 1, true), 'the pair alone must still show, got ' .. winbar())

-- Unbound (":set project" onto another project clears the room): back to plain.
fp.handle_event({ type = 'room', projectSlug = nil, endpointSlug = nil, name = nil })
assert(winbar() == '', 'clearing the bind must clear the winbar, got ' .. vim.inspect(winbar()))
assert(bufname():match('flurryport://feed$'), 'clearing the bind must restore the plain name, got ' .. bufname())

print('ROOM OK')
