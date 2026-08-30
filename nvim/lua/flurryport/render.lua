-- ConsoleEvent -> buffer lines. The ratified two-line feed row is kept: a scannable
-- meta line, then the message indented beneath it.
--
-- Two deliberate differences from the terminal renderer. Wrapping is nvim's job
-- ('wrap' + 'linebreak' + 'breakindent'), so nothing is hard-wrapped here and the
-- text reflows when a window resizes - the terminal feed cannot do that because it
-- is append-only. And colors are highlight groups rather than ANSI, so the same
-- event paints correctly in any colorscheme.

local M = {}

M.INDENT = '  '

--- When true, a post's BODY carries its seat colour, not just the byline. ON by
--- default (ruled 08-16, #269); the quieter byline-only read stays one toggle
--- away. Toggled live by :FlurryPORT bodies.
M.color_bodies = true

--- Palette name -> highlight group. The engine sends the full palette under --json
--- (stdout is a pipe; the client decides what it can paint), so every name resolves.
local COLOR_GROUP = {
  red = 'FlurryPortRed',
  green = 'FlurryPortGreen',
  yellow = 'FlurryPortYellow',
  blue = 'FlurryPortBlue',
  magenta = 'FlurryPortMagenta',
  cyan = 'FlurryPortCyan',
  white = 'FlurryPortWhite',
  gray = 'FlurryPortGray',
  grey = 'FlurryPortGray',
  purple = 'FlurryPortPurple',
  orange = 'FlurryPortOrange',
  pink = 'FlurryPortPink',
  teal = 'FlurryPortTeal',
}

--- Every capture id this session has rendered (#259): the pool short_id measures
--- prefixes against. The engine accepts the same prefixes back at :tag, so what
--- the meta line shows is always a working argument.
---@type table<string, boolean>
local known_ids = {}

--- The floor on a displayed prefix, matching the engine's resolution floor.
M.ID_PREFIX_FLOOR = 6

function M.reset_ids()
  known_ids = {}
end

--- The shortest prefix of `id` (at least the floor) unique among every id seen
--- so far; the full id when nothing shorter is unambiguous. Ids at or under the
--- floor render whole.
---@param id string
---@return string
local function short_id(id)
  known_ids[id] = true
  for len = M.ID_PREFIX_FLOOR, #id - 1 do
    local prefix = id:sub(1, len)
    local unique = true
    for other in pairs(known_ids) do
      if other ~= id and other:sub(1, len) == prefix then
        unique = false
        break
      end
    end
    if unique then
      return prefix
    end
  end
  return id
end

---@class fp.Line
---@field text string
---@field hls table[]  list of { group = string, from = integer, to = integer } byte columns

---@param text string
---@param group string|nil
---@return fp.Line
local function line(text, group)
  local hls = {}
  if group then
    table.insert(hls, { group = group, from = 0, to = -1 })
  end
  return { text = text, hls = hls }
end

--- `at` arrives as a UTC ISO instant. It is shown in LOCAL time, because the
--- terminal frontend does, and two surfaces disagreeing about what time a post
--- landed is worse than either choice on its own.
---@param iso string
---@return integer|nil epoch seconds
local function to_epoch(iso)
  local y, mo, d, h, mi, s = iso:match('(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)')
  if not y then
    return nil
  end
  -- os.time reads its table as LOCAL, so the fields (which are UTC) come out
  -- shifted; correcting by the current offset puts the instant back where it was.
  local as_local = os.time({ year = tonumber(y), month = tonumber(mo), day = tonumber(d),
    hour = tonumber(h), min = tonumber(mi), sec = tonumber(s), isdst = false })
  local offset = os.difftime(os.time(), os.time(os.date('!*t')))
  return as_local + offset
end

--- Time only for today's rows; MM-DD in front for anything older, so a backfill
--- reaching back days cannot read as live traffic (the same rule the CLI applies).
---@param at string
local function clock(at)
  local epoch = to_epoch(at)
  if not epoch then
    return at
  end
  if os.date('%Y-%m-%d', epoch) == os.date('%Y-%m-%d') then
    return os.date('%H:%M:%S', epoch)
  end
  return os.date('%m-%d %H:%M:%S', epoch)
end

---@param item table
---@return fp.Line
local function meta_line(item)
  local parts = {}
  local hls = {}
  local function put(text, group)
    if text == '' then
      return
    end
    local from = #table.concat(parts, '')
    table.insert(parts, text)
    if group then
      table.insert(hls, { group = group, from = from, to = from + #text })
    end
  end

  put(clock(item.at), 'FlurryPortDim')
  put(' ')
  -- The shortest unique prefix stands in for the full id (#259): long ids were
  -- crowding the meta line, and the engine takes the prefix back at :tag.
  put(item.id and short_id(item.id) or '', 'FlurryPortDim')
  put(' ')
  put(item.byline or '', COLOR_GROUP[item.color or ''] or 'FlurryPortByline')

  -- The addressee wears a color too (#263): the engine resolves `to` against
  -- the roster (seat color, suffixed handles included) and the chair's own
  -- address and byline (chair color); null falls back to the meta style here.
  local to_group = item.toColor and COLOR_GROUP[item.toColor] or 'FlurryPortDim'
  if item.channel == 'whisper' then
    put(' whispers to ', 'FlurryPortDim')
    put(item.to or '', to_group)
  elseif item.channel == 'scratch' then
    -- #282: the out-of-band channel wears its name, dim - commentary, not direction.
    put(' (scratch)', 'FlurryPortDim')
  elseif item.channel == 'mention' and item.to then
    put(' to ', 'FlurryPortDim')
    put(item.to, to_group)
  end

  if item.panic then
    put('  PANIC', 'FlurryPortPanic')
  end

  if item.verb then
    local shown = item.verb.display or ''
    if item.verb.args and #item.verb.args > 0 then
      shown = shown .. ' ' .. table.concat(item.verb.args, ' ')
    end
    put('  ' .. shown, 'FlurryPortVerb')
    if item.verb.recipe then
      put(' (recipe verb)', 'FlurryPortDim')
    end
  end

  if item.re then
    put((' [re %s]'):format(item.re), 'FlurryPortDim')
  end

  for _, tag in ipairs(item.tags or {}) do
    put((' [%s]'):format(tag), 'FlurryPortTag')
  end

  return { text = table.concat(parts, ''), hls = hls }
end

--- Turn one event into buffer lines. Returns an empty list for events that belong
--- to a different surface (roster and status paint the presence window instead).
---@param event table
---@return fp.Line[]
function M.event(event)
  local out = {}
  local t = event.type

  if t == 'feed' then
    local item = event.item
    -- The status ticker (#280b): a protocol status (string state) is ONE dim
    -- line - state, then reason or task. A pure fp:status transition IS the
    -- whole row; a consecutive same-seat same-state repeat collapses to nothing
    -- new. The engine decides pure/repeated; this renderer only obeys.
    local ticker = item.statusTicker
    local ticker_text = ticker and (ticker.state .. (ticker.detail and (': ' .. ticker.detail) or '')) or nil
    local ticker_group = ticker and ticker.state == 'blocked-on-human' and 'FlurryPortError' or 'FlurryPortDim'
    if ticker and ticker.pure then
      if not ticker.repeated then
        local meta = clock(item.at) .. ' ' .. (item.id and short_id(item.id) or '') .. ' '
          .. (item.byline or '') .. ' ' .. ticker_text
        table.insert(out, line(meta, ticker_group))
      end
      return out
    end
    table.insert(out, meta_line(item))
    if item.text and item.text ~= '' then
      -- The byline always carries the seat colour; the BODY only when asked for.
      -- `:me color` paints the name, and with several seats talking that reads
      -- better than a fully coloured feed - but it is a taste call, so it toggles.
      local body_group = M.color_bodies and (COLOR_GROUP[item.color or ''] or 'FlurryPortByline') or nil
      for _, l in ipairs(vim.split(item.text, '\n', { plain = true })) do
        table.insert(out, line(M.INDENT .. l, body_group))
      end
    end
    if ticker then
      -- Riding a content post, the ticker replaces the key: value stanza dump.
      if not ticker.repeated then
        table.insert(out, line(M.INDENT .. M.INDENT .. ticker_text, ticker_group))
      end
    else
      for key, value in pairs(item.status or {}) do
        local shown = type(value) == 'string' and value or vim.inspect(value)
        table.insert(out, line(M.INDENT .. M.INDENT .. key .. ': ' .. shown, 'FlurryPortDim'))
      end
    end
  elseif t == 'info' then
    table.insert(out, line(event.text, 'FlurryPortInfo'))
  elseif t == 'error' then
    table.insert(out, line(event.text, 'FlurryPortError'))
  elseif t == 'help' then
    for _, l in ipairs(event.lines or {}) do
      table.insert(out, line(l, 'FlurryPortDim'))
    end
  elseif t == 'ask' or t == 'confirm' then
    table.insert(out, line(event.text, 'FlurryPortAsk'))
  elseif t == 'pairing' then
    -- The boarding pass is the one thing here meant to leave the editor by hand,
    -- so it is rendered plain and whole: selectable, copyable, unstyled.
    table.insert(out, line(''))
    table.insert(out, line('  ' .. event.code, 'FlurryPortAsk'))
    table.insert(out, line(''))
    for _, l in ipairs(event.chairLines or {}) do
      table.insert(out, line(l, 'FlurryPortDim'))
    end
    for _, l in ipairs(event.passLines or {}) do
      table.insert(out, line(l))
    end
  elseif t == 'projects' then
    for _, row in ipairs(event.rows or {}) do
      local mark = row.suspended and '  (suspended)' or ''
      -- The slug is the part you type; the name is context. Colour them apart.
      local text = ('  %s  %s%s'):format(row.slug, row.name or '', mark)
      table.insert(out, {
        text = text,
        hls = {
          { group = 'FlurryPortSlug', from = 2, to = 2 + #row.slug },
          { group = 'FlurryPortDim', from = 2 + #row.slug, to = -1 },
        },
      })
    end
  elseif t == 'endpoints' then
    for _, row in ipairs(event.rows or {}) do
      -- Printed in the form :set accepts back, so a yank is a working command -
      -- which is exactly why the pasteable half is the half that stands out.
      local pair = ('%s/%s'):format(row.projectSlug, row.slug)
      local text = ('  %s  %s'):format(pair, row.name or '')
      table.insert(out, {
        text = text,
        hls = {
          { group = 'FlurryPortSlug', from = 2, to = 2 + #pair },
          { group = 'FlurryPortDim', from = 2 + #pair, to = -1 },
        },
      })
    end
  elseif t == 'colors' then
    table.insert(out, line('  ' .. table.concat(event.colors or {}, ', '), 'FlurryPortInfo'))
  end

  return out
end

--- The empty-roster line, shared with the panel-width floor (#260): the panel
--- must never be too narrow to say it has nothing to say.
M.EMPTY_ROSTER = '  no seats at the table'
M.ALL_ROSTER = 'all'

--- The decisions section header (#295), under the seat rows in the same panel.
M.DECISIONS_HEADER = '  decisions'

--- The clear row's label (#295, Gene's order from the code-2 room): the
--- decisions twin of the seat rows' `all`. It reads `none` because the panel's
--- lead rows name TARGETS, not actions - `all` addresses every seat, `none`
--- selects no decision - and a verb label would be the one action word in a
--- panel of nouns and names.
M.NONE_DECISION = 'none'

--- Gene's ruling (#295): a panel entry is THREE TO FIVE WORDS MAX - the first
--- five words of the proposal's summary, fewer when the summary is shorter,
--- and never an ellipsis row longer than that.
---@param summary string|nil
---@return string
function M.decision_words(summary)
  local words = {}
  for w in tostring(summary or ''):gmatch('%S+') do
    table.insert(words, w)
    if #words == 5 then
      break
    end
  end
  return table.concat(words, ' ')
end

--- The decisions section (#295): one row per ledger entry, in feed order, under
--- a header. State reads as a marker in the panel's compact idiom - the words
--- would eat the width the five-word cap protects:
---   ?  needs ratification (yellow: the gavel is owed, like held/idle)
---   *  ratified           (green: settled, like live)
---   ~  retracted          (the whole row dims, the post-mortem grey idiom)
--- Struck rows are OMITTED: struck means unsaid, and the panel is the room's
--- glanceable state, not the archive - :list decisions still shows them.
--- Empty (or all-struck) ledgers render no section at all. Each entry line
--- carries `decision = row` so ui can turn a cursor line back into a decision,
--- the presence_rows contract.
---@param rows table[]
---@return fp.Line[]
function M.decisions(rows)
  local out = {}
  for _, row in ipairs(rows or {}) do
    if row.state ~= 'struck' then
      local words = M.decision_words(row.summary)
      if row.state == 'retracted' then
        table.insert(out, {
          text = '  ~ ' .. words,
          hls = { { group = 'FlurryPortDim', from = 0, to = -1 } },
          decision = row,
        })
      else
        local marker = row.state == 'ratified' and '*' or '?'
        local group = row.state == 'ratified' and 'FlurryPortGreen' or 'FlurryPortYellow'
        table.insert(out, {
          text = '  ' .. marker .. ' ' .. words,
          hls = { { group = group, from = 2, to = 3 } },
          decision = row,
        })
      end
    end
  end
  if #out == 0 then
    return {}
  end
  table.insert(out, 1, { text = '', hls = {} })
  table.insert(out, 2, { text = M.DECISIONS_HEADER, hls = { { group = 'FlurryPortInfo', from = 0, to = -1 } } })
  -- The clear row leads the entries, the `all` idiom exactly: Enter drops the
  -- armed decision and returns a decision thread to live. It is PART of the
  -- section - an empty (or all-struck) ledger still drops the whole section,
  -- clear row included, because there is nothing to clear.
  local none = line('  ' .. M.NONE_DECISION, 'FlurryPortInfo')
  none.decision_clear = true
  table.insert(out, 3, none)
  return out
end

--- The presence strip: one row per seat, newest state first in the eye's path.
--- Handles pad to the longest at the table (#260), so the state column starts
--- where the widest handle ends, and every offset is computed, never assumed.
---@param rows table[]
---@return fp.Line[]
function M.presence(rows)
  -- The synthetic `all` row is the discoverable way back out of a seat thread.
  -- `all` is reserved by the seat mint, so it cannot shadow a real participant.
  local out = { line('  ' .. M.ALL_ROSTER, 'FlurryPortInfo') }
  if #rows == 0 then
    table.insert(out, line(M.EMPTY_ROSTER, 'FlurryPortDim'))
    return out
  end
  local widest = 0
  for _, row in ipairs(rows) do
    widest = math.max(widest, #(row.handle or '?'))
  end
  local handle_at = 2
  local state_at = handle_at + widest + 1
  for _, row in ipairs(rows) do
    local state = row.state or '?'
    -- The four presence words (#266) plus held: green is attending, yellow is
    -- seated but not attending, grey is gone (departed and the invite
    -- post-mortem states fall through to dim/gray).
    local state_group = (state == 'live' and 'FlurryPortGreen')
      or ((state == 'held' or state == 'idle') and 'FlurryPortYellow')
      or (state == 'departed' and 'FlurryPortGray')
      or 'FlurryPortDim'
    local handle = row.handle or '?'
    local posts = row.posts and ('%d posts'):format(row.posts) or ''
    local text = ('  %-' .. widest .. 's %-8s %s'):format(handle, state, posts):gsub('%s+$', '')
    -- The handle keeps the seat's OWN color so the strip and the feed agree at a
    -- glance; only the state word carries the liveness color. A greyed row
    -- (#267: revoked/expired/departed) loses the seat color entirely.
    local handle_group = (row.greyed == true) and 'FlurryPortGray'
      or (COLOR_GROUP[row.color or ''] or 'FlurryPortByline')
    table.insert(out, {
      text = text,
      hls = {
        { group = handle_group, from = handle_at, to = handle_at + #handle },
        { group = state_group, from = state_at, to = state_at + #state },
      },
    })
  end
  return out
end

return M
