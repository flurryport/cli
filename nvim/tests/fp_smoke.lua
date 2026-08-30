-- Load the plugin off the repo path and exercise the pure parts headlessly.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local ok, err = pcall(function() require('flurryport').setup({}) end)
assert(ok, 'setup failed: ' .. tostring(err))

local render = require('flurryport.render')

-- 1. a feed row renders two-line with the meta first
local item = {
  at = '2026-08-14T23:38:01Z', id = '2sUyLVvQcB', byline = 'george', color = 'cyan',
  channel = 'mention', to = 'director', text = 'line one\nline two', mine = false,
  verb = nil, re = nil, panic = false, status = nil, tags = { 'unknown kind: draft' },
}
local lines = render.event({ type = 'feed', item = item })
assert(#lines == 3, 'expected meta + 2 text lines, got ' .. #lines)
-- #259: the meta line carries the shortest unique id prefix, floor 6.
assert(lines[1].text:find('2sUyLV', 1, true), 'meta carries the id prefix')
assert(lines[1].text:find('george'), 'meta carries the byline')
assert(lines[1].text:find('to director'), 'meta carries the addressee')
assert(lines[1].text:find('%[unknown kind: draft%]'), 'meta carries tags')
assert(not lines[1].text:find('line one'), 'the message never rides the meta line')
assert(lines[2].text == '  line one', 'text indented: ' .. lines[2].text)

-- 2. a verb row puts the verb on the meta line and no body
local vlines = render.event({ type = 'feed', item = vim.tbl_extend('force', item, {
  text = '', verb = { raw = 'fp:install', display = 'install', recipe = false, args = { 'slack-post' } },
}) })
assert(#vlines == 1, 'verb with no text is meta only, got ' .. #vlines)
assert(vlines[1].text:find('install slack%-post'), 'verb and args on the meta line')

-- 3. stale rows carry a date, today's do not
local today = os.date('!%Y-%m-%dT%H:%M:%SZ')
local fresh = render.event({ type = 'feed', item = vim.tbl_extend('force', item, { at = today }) })
assert(fresh[1].text:match('^%d%d:%d%d:%d%d'), 'today is time only: ' .. fresh[1].text)
local old = render.event({ type = 'feed', item = vim.tbl_extend('force', item, { at = '2026-08-13T16:37:32Z' }) })
assert(old[1].text:match('^08%-13 '), 'older rows carry MM-DD: ' .. old[1].text)

-- 4. endpoints print in the form :set accepts back
local eps = render.event({ type = 'endpoints', rows = { { projectSlug = 'recipe-vetting', slug = 'writers-room', name = 'Writers-room' } } })
assert(eps[1].text:find('recipe%-vetting/writers%-room'), 'endpoint row is a pasteable bind')

-- 5. presence strip
local p = render.presence({ { handle = 'george', state = 'live', posts = 2, color = 'cyan' } })
assert(p[1].text:find('all'), 'presence offers the full roster')
assert(p[2].text:find('george'), 'presence names the seat')
assert(p[2].text:find('live'), 'presence shows state')
assert(#render.presence({}) == 2, 'empty roster keeps all plus its placeholder')

-- 6. commands registered
local cmds = vim.api.nvim_get_commands({})
assert(cmds['FlurryPORT'], 'missing :FlurryPORT')
-- ONE name only: no aliases, no second prefix to collide with
for _, name in ipairs({ 'Fp', 'FlurryPort', 'FlurryPortClose', 'FpSay', 'FpEnvoy', 'FpFeed', 'FpPresence' }) do
  assert(not cmds[name], 'stale top-level command still registered: ' .. name)
end
-- and it is reachable by the prefix nobody has to be told about
local ok = pcall(vim.cmd, 'Fl feed')
assert(ok, ':Fl did not resolve to :FlurryPORT')

print('SMOKE OK')
