vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport'); local ui = require('flurryport.ui'); local render = require('flurryport.render')
fp.setup({ presence_interval = 0 })
ui.open(function() end)

local item = { at = '2026-08-15T18:00:00Z', id = 'c1', byline = 'bunny', color = 'red',
  channel = 'room', to = nil, text = 'line one\nline two', mine = false,
  verb = nil, re = nil, panic = false, status = nil, tags = {} }

-- Default ON (#269): setup with no opts leaves seat-coloured bodies enabled.
assert(render.color_bodies == true, 'coloured bodies are the default now')
local lines = render.event({ type = 'feed', item = item })
assert(#lines[1].hls > 0, 'byline lost its colour')
assert(lines[2].hls[1].group == 'FlurryPortRed', 'body did not take the seat colour by default: '
  .. vim.inspect(lines[2].hls))
assert(lines[3].hls[1].group == 'FlurryPortRed', 'only the first body line was coloured')

-- The toggle still works: OFF mutes bodies, the byline keeps its colour.
render.color_bodies = false
lines = render.event({ type = 'feed', item = item })
assert(#lines[1].hls > 0, 'byline keeps its colour either way')
assert(#lines[2].hls == 0, 'body is coloured while the toggle is off')

-- The toggle repaints what is ALREADY on screen, not just future posts.
ui.push({ type = 'feed', item = item }) -- pushed while off: renders plain
local n = vim.api.nvim_buf_line_count(ui.buf.feed)
render.color_bodies = true
ui.repaint()
assert(vim.api.nvim_buf_line_count(ui.buf.feed) == n, 'repaint changed the line count')
local marks = vim.api.nvim_buf_get_extmarks(ui.buf.feed, ui.ns, 0, -1, { details = true })
local coloured = vim.tbl_filter(function(m) return m[4].hl_group == 'FlurryPortRed' end, marks)
assert(#coloured >= 3, 'repaint did not recolour existing bodies, got ' .. #coloured)

-- An explicit opt-out in setup still lands.
fp.setup({ presence_interval = 0, color_bodies = false })
assert(render.color_bodies == false, 'setup({ color_bodies = false }) opts out')

print('BODIES OK')
