vim.opt.runtimepath:append(vim.env.FP_NVIM)
require('flurryport').setup({})
local render = require('flurryport.render')

local info = render.event({ type = 'info', text = 'Bound to a/b.' })
assert(info[1].hls[1].group == 'FlurryPortInfo', 'info is not its own group')

local eps = render.event({ type = 'endpoints', rows = { { projectSlug = 'recipe-vetting', slug = 'writers-room', name = 'Writers-room' } } })
local groups = vim.tbl_map(function(h) return h.group end, eps[1].hls)
assert(vim.tbl_contains(groups, 'FlurryPortSlug'), 'the pasteable pair is not highlighted apart')
assert(vim.tbl_contains(groups, 'FlurryPortDim'), 'the name is not dimmed')
-- The slug span must cover exactly the pasteable pair, nothing more.
local slug = vim.tbl_filter(function(h) return h.group == 'FlurryPortSlug' end, eps[1].hls)[1]
assert(eps[1].text:sub(slug.from + 1, slug.to) == 'recipe-vetting/writers-room',
  'slug span is off: ' .. eps[1].text:sub(slug.from + 1, slug.to))

-- Every group the plugin uses must actually be defined, or it renders as Normal.
for _, g in ipairs({ 'FlurryPortInfo', 'FlurryPortSlug', 'FlurryPortDim', 'FlurryPortByline',
                     'FlurryPortError', 'FlurryPortAsk', 'FlurryPortVerb', 'FlurryPortTag',
                     'FlurryPortPanic' }) do
  assert(vim.api.nvim_get_hl(0, { name = g }).link or next(vim.api.nvim_get_hl(0, { name = g })),
    'undefined highlight group: ' .. g)
end
-- A colorscheme switch must not wipe them.
vim.cmd('colorscheme default')
for _, g in ipairs({ 'FlurryPortInfo', 'FlurryPortSlug', 'FlurryPortByline' }) do
  local hl = vim.api.nvim_get_hl(0, { name = g })
  assert(hl.link or next(hl), 'group lost after :colorscheme: ' .. g)
end
print('HL OK')
