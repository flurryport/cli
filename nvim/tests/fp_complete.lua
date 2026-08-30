-- #257: <Tab> completion in the prompt. Candidates come from cached room data;
-- a quiet fetch caches without painting; user listings still paint.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
local complete = require('flurryport.complete')
fp.setup({ presence_interval = 0 })
ui.open(function() end)
fp.attach_completion(ui.buf.prompt)
complete.reset()

-- 1. an empty cache wants both room lists, and arms the quiet flags
local wanted = complete.fetch_lines()
assert(#wanted == 2, 'an empty cache wants both lists, got ' .. #wanted)
assert(wanted[1] == ':list projects' and wanted[2] == ':list endpoints',
  'unexpected fetch lines: ' .. table.concat(wanted, ' | '))

-- 2. quiet answers fill the cache and never paint the feed
local before = vim.api.nvim_buf_line_count(ui.buf.feed)
fp.handle_event({ type = 'projects', rows = { { slug = 'foo' }, { slug = 'bar' } } })
fp.handle_event({ type = 'endpoints', rows = {
  { projectSlug = 'foo', slug = 'room', name = 'Room' },
  { projectSlug = 'bar', slug = 'other', name = 'Other' },
} })
assert(vim.api.nvim_buf_line_count(ui.buf.feed) == before, 'a quiet fetch painted the feed')
assert(#complete.projects == 2 and #complete.endpoints == 2, 'quiet answers were not cached')

-- 3. a warm cache wants no fetch; a USER listing still paints
assert(#complete.fetch_lines() == 0, 'a warm cache still wants fetches')
fp.handle_event({ type = 'endpoints', rows = { { projectSlug = 'foo', slug = 'room', name = 'Room' } } })
local feed = table.concat(vim.api.nvim_buf_get_lines(ui.buf.feed, 0, -1, false), '\n')
assert(feed:find('foo/room'), 'a user-typed listing was swallowed')

-- 4. a quiet miss (the error answer) is consumed too
complete.reset()
local rearm = complete.fetch_lines()
assert(#rearm == 2, 'reset did not re-arm the fetch')
local at = vim.api.nvim_buf_line_count(ui.buf.feed)
fp.handle_event({ type = 'error', text = 'This account has no projects.' })
fp.handle_event({ type = 'error', text = 'No endpoints on this account.' })
assert(vim.api.nvim_buf_line_count(ui.buf.feed) == at, 'a quiet miss painted an error')
-- and an unrelated error afterwards still paints
fp.handle_event({ type = 'error', text = 'The feed hit network trouble (down).' })
assert(vim.api.nvim_buf_line_count(ui.buf.feed) > at, 'an unrelated error was swallowed')

-- refill the cache for the candidate cases
fp.handle_event({ type = 'projects', rows = { { slug = 'foo' }, { slug = 'bar' } } })
fp.handle_event({ type = 'endpoints', rows = {
  { projectSlug = 'foo', slug = 'room', name = 'Room' },
  { projectSlug = 'bar', slug = 'other', name = 'Other' },
} })

-- 5. :set completes project slugs and project/endpoint pairs
local c = complete.candidates(':set f')
assert(c and c.start == 5, ':set word start is off: ' .. tostring(c and c.start))
assert(vim.tbl_contains(c.matches, 'foo') and vim.tbl_contains(c.matches, 'foo/room'),
  ':set f missed a form: ' .. table.concat(c.matches, ' | '))
assert(not vim.tbl_contains(c.matches, 'bar'), ':set f offered a non-match')

-- 6. a slash narrows to that project's pairs
c = complete.candidates(':set foo/')
assert(c and #c.matches == 1 and c.matches[1] == 'foo/room',
  'pair completion is off: ' .. table.concat(c.matches, ' | '))

-- 7. the noun forms complete their own slugs
c = complete.candidates(':set project b')
assert(c and #c.matches == 1 and c.matches[1] == 'bar', ':set project is off')
c = complete.candidates(':set endpoint ')
assert(c and vim.tbl_contains(c.matches, 'room') and vim.tbl_contains(c.matches, 'other'),
  'unscoped :set endpoint should offer every endpoint')

-- 8. a bound project scopes bare endpoints and :set endpoint
fp.handle_event({ type = 'info', text = 'Bound to foo/room. 2 seats at the table. The feed is live.' })
assert(complete.bound_project == 'foo', 'the bind receipt did not set the scope')
c = complete.candidates(':set endpoint ')
assert(c and #c.matches == 1 and c.matches[1] == 'room', 'bound :set endpoint should scope to the project')
c = complete.candidates(':set r')
assert(c and vim.tbl_contains(c.matches, 'room'), 'a bound project should offer its bare endpoints')

-- 9. handles come off the roster and complete mentions and post words
fp.handle_event({ type = 'roster', rows = {
  { handle = 'bunny', guestName = 'Bunny', status = 'accepted', live = true, held = false, color = 'cyan', hidden = false, endpointSlug = 'room' },
  { handle = 'the-tall-bard', guestName = 'The Tall Bard', status = 'accepted', live = true, held = false, color = 'red', hidden = false, endpointSlug = 'room' },
} })
c = complete.candidates(':bun')
assert(c and c.start == 1 and #c.matches == 1 and c.matches[1] == 'bunny', 'mention completion is off')
c = complete.candidates('nice work the-t')
assert(c and c.start == #'nice work ' and c.matches[1] == 'the-tall-bard',
  'handles should complete anywhere in a post line')
-- past the first token of a colon line, nothing completes (arguments are prose)
assert(complete.candidates(':bunny nice') == nil, 'colon-line prose should not complete')

-- 10. the key is wired on the prompt buffer, insert mode, buffer local
local map = vim.fn.maparg('<Tab>', 'i', false, true)
assert(map.buffer == 1, 'no buffer-local <Tab> map on the prompt')

print('COMPLETE OK')
