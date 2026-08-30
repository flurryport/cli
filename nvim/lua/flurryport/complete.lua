-- Prompt completion (#257): <Tab> completes :set argument forms from cached room
-- data, and seat handles for mentions. The pure candidate logic lives here so the
-- headless suite can drive it without a console; init.lua only wires the key.
--
-- The cache is fed by note_event, which sees every ConsoleEvent before the feed
-- does. A completion that finds the cache empty asks for a QUIET fetch: the room
-- lists are requested from the console, cached on arrival, and consumed here so
-- nothing paints into the feed. A listing the USER typed paints exactly as before;
-- quiet only ever covers answers this module asked for.

local M = {}

--- Cached room data, session scoped. Lists keep arrival order for stable menus.
---@type string[]
M.projects = {}
--- Endpoint rows as { project = <slug>, slug = <slug> }.
---@type { project: string, slug: string }[]
M.endpoints = {}
--- Seat handles off roster and status events: what a mention actually types.
---@type string[]
M.handles = {}
--- The bound (or set) project slug, parsed off the console's own receipts.
---@type string|nil
M.bound_project = nil

--- Quiet-fetch bookkeeping: how many projects/endpoints answers to consume.
local quiet = { projects = 0, endpoints = 0 }

function M.reset()
  M.projects, M.endpoints, M.handles, M.bound_project = {}, {}, {}, nil
  quiet = { projects = 0, endpoints = 0 }
end

---@param list string[]
---@param value string
local function add_unique(list, value)
  for _, v in ipairs(list) do
    if v == value then
      return
    end
  end
  table.insert(list, value)
end

---@param project string
---@param slug string
local function add_endpoint(project, slug)
  for _, e in ipairs(M.endpoints) do
    if e.project == project and e.slug == slug then
      return
    end
  end
  table.insert(M.endpoints, { project = project, slug = slug })
end

--- Feed one ConsoleEvent through the cache. Returns true when the event answered
--- a quiet fetch and must NOT paint into the feed.
---@param event table
---@return boolean consumed
function M.note_event(event)
  local t = event.type
  if t == 'projects' then
    for _, row in ipairs(event.rows or {}) do
      if row.slug then
        add_unique(M.projects, row.slug)
      end
    end
    if quiet.projects > 0 then
      quiet.projects = quiet.projects - 1
      return true
    end
  elseif t == 'endpoints' then
    for _, row in ipairs(event.rows or {}) do
      if row.projectSlug and row.slug then
        add_unique(M.projects, row.projectSlug)
        add_endpoint(row.projectSlug, row.slug)
      end
    end
    if quiet.endpoints > 0 then
      quiet.endpoints = quiet.endpoints - 1
      return true
    end
  elseif t == 'roster' or t == 'status' then
    for _, row in ipairs(event.rows or {}) do
      if row.handle then
        add_unique(M.handles, row.handle)
      end
    end
  elseif t == 'error' and event.text then
    -- A quiet :list that found nothing answers with an error line. It is ours
    -- only while a quiet fetch is pending, and it must not paint either.
    if quiet.projects > 0 and event.text:find('^This account has no projects') then
      quiet.projects = quiet.projects - 1
      return true
    end
    if quiet.endpoints > 0 and event.text:find('^No endpoints') then
      quiet.endpoints = quiet.endpoints - 1
      return true
    end
  elseif t == 'info' and event.text then
    local project = event.text:match('^Bound to ([^/]+)/') or event.text:match('^Project set to (%S+)%.')
    if project then
      M.bound_project = project
    end
  end
  return false
end

--- Is this prompt text a :set line at all? Decides whether an empty answer is
--- worth a quiet fetch.
---@param typed string
---@return boolean
function M.is_set_context(typed)
  return typed:match('^:set%f[%s]') ~= nil
end

--- The console lines a :set completion needs sent when its cache is empty. Arms
--- the quiet counters; the caller sends the lines to the console verbatim.
---@return string[]
function M.fetch_lines()
  local out = {}
  if #M.projects == 0 then
    quiet.projects = quiet.projects + 1
    table.insert(out, ':list projects')
  end
  if #M.endpoints == 0 then
    quiet.endpoints = quiet.endpoints + 1
    table.insert(out, ':list endpoints')
  end
  return out
end

--- Endpoint slugs, scoped to a project when one is given.
---@param project string|nil
---@return string[]
local function endpoint_slugs(project)
  local out = {}
  for _, e in ipairs(M.endpoints) do
    if project == nil or e.project == project then
      add_unique(out, e.slug)
    end
  end
  return out
end

--- project/endpoint pairs, scoped to a project when one is given.
---@param project string|nil
---@return string[]
local function pair_forms(project)
  local out = {}
  for _, e in ipairs(M.endpoints) do
    if project == nil or e.project == project then
      add_unique(out, e.project .. '/' .. e.slug)
    end
  end
  return out
end

---@param list string[]
---@param word string
---@return string[]
local function prefixed(list, word)
  local out = {}
  for _, v in ipairs(list) do
    if v:find(word, 1, true) == 1 then
      table.insert(out, v)
    end
  end
  return out
end

--- Candidates for the text before the cursor (prompt prefix already stripped).
--- Returns start (byte offset into `typed` where the completed word begins) and
--- the matches, or nil when this position completes nothing.
---@param typed string
---@return { start: integer, matches: string[] }|nil
function M.candidates(typed)
  -- :set project <p> and :set endpoint <e> complete their own noun's slugs.
  local word = typed:match('^:set%s+project%s+(%S*)$')
  if word then
    return { start = #typed - #word, matches = prefixed(M.projects, word) }
  end
  word = typed:match('^:set%s+endpoint%s+(%S*)$')
  if word then
    return { start = #typed - #word, matches = prefixed(endpoint_slugs(M.bound_project), word) }
  end
  -- :set <arg>: project slugs, project/endpoint pairs, and bare endpoint slugs
  -- when a project is already set (those bind directly).
  word = typed:match('^:set%s+(%S*)$')
  if word then
    local pool = {}
    local project = word:match('^([^/]+)/')
    if project then
      pool = pair_forms(project)
    else
      for _, p in ipairs(M.projects) do
        add_unique(pool, p)
      end
      for _, pair in ipairs(pair_forms(nil)) do
        add_unique(pool, pair)
      end
      if M.bound_project then
        for _, slug in ipairs(endpoint_slugs(M.bound_project)) do
          add_unique(pool, slug)
        end
      end
    end
    return { start = #typed - #word, matches = prefixed(pool, word) }
  end
  -- Seat handles: the mention target of a ':<handle>' line, and the word under
  -- the cursor anywhere in a bare post line.
  word = typed:match('^:(%S*)$')
  if word then
    return { start = #typed - #word, matches = prefixed(M.handles, word) }
  end
  if not typed:match('^%s*:') then
    word = typed:match('(%S+)$')
    if word then
      return { start = #typed - #word, matches = prefixed(M.handles, word) }
    end
  end
  return nil
end

return M
