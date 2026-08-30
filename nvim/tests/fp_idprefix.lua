-- #259: the feed meta line shows the shortest unique capture-id prefix (floor 6)
-- instead of the full id. The engine accepts the same prefixes back at :tag, so
-- what the meta line shows is always a working argument.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
require('flurryport').setup({})
local render = require('flurryport.render')
render.reset_ids()

local function feed(id)
  return render.event({ type = 'feed', item = {
    at = '2026-08-15T18:00:00Z', id = id, byline = 'bunny', color = nil,
    channel = 'room', to = nil, text = 'hi', mine = false,
    verb = nil, re = nil, panic = false, status = nil, tags = {},
  } })
end

-- 1. a lone id renders at the floor width, never whole
local lines = feed('2sUyLVvQcB')
assert(lines[1].text:find('2sUyLV', 1, true), 'no floor prefix: ' .. lines[1].text)
assert(not lines[1].text:find('2sUyLVvQcB', 1, true), 'the full id still rides the meta line')

-- 2. a collision extends the prefix only as far as uniqueness needs
lines = feed('2sUyLVvXaa')
assert(lines[1].text:find('2sUyLVvX', 1, true), 'colliding id did not extend: ' .. lines[1].text)
assert(not lines[1].text:find('2sUyLVvXa', 1, true), 'prefix longer than uniqueness needs')

-- 3. re-rendering the first id now knows about the collision (repaint honesty)
lines = feed('2sUyLVvQcB')
assert(lines[1].text:find('2sUyLVvQ', 1, true), 'repaint kept a stale prefix: ' .. lines[1].text)

-- 4. ids at or under the floor render whole
lines = feed('abc')
assert(lines[1].text:find(' abc ', 1, true), 'a short id should render whole: ' .. lines[1].text)

-- 5. an id that never becomes unique renders whole
render.reset_ids()
feed('abcdefgh')
lines = feed('abcdefg')
assert(lines[1].text:find('abcdefg', 1, true) and not lines[1].text:find('abcdefgh', 1, true),
  'a prefix-of-another id must render whole: ' .. lines[1].text)

-- 6. reset empties the pool (a closed room starts clean)
render.reset_ids()
lines = feed('2sUyLVvQcB')
assert(lines[1].text:find('2sUyLV ', 1, true), 'reset did not clear the pool: ' .. lines[1].text)

print('IDPREFIX OK')
