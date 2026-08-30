-- Buffers and windows. The layout is the point of doing this in nvim at all:
--
--   +-----------------------------+-----------+
--   |            feed             | presence  |
--   |                             |  (pinned) |
--   +-----------------------------+-----------+
--   | > prompt                                |
--   +-----------------------------------------+
--
-- The presence strip updates IN PLACE, which is the thing a scrolling terminal
-- feed structurally cannot do. Everything else - scrollback, search, per-envoy
-- buffers, window motions - is nvim's, not reimplemented here.

local render = require('flurryport.render')

local M = {}

M.ns = vim.api.nvim_create_namespace('flurryport')

---@type { feed: integer|nil, presence: integer|nil, prompt: integer|nil, envoys: table<string, integer>, decisions: table<string, integer> }
M.buf = { feed = nil, presence = nil, prompt = nil, envoys = {}, decisions = {} }
M.win = { feed = nil, presence = nil, prompt = nil }

--- Every feed item seen this session, kept so an envoy buffer can be built on
--- demand rather than maintained eagerly for seats nobody asks about.
---@type table[]
M.items = {}

--- Every event the feed has shown, in order. Kept so a display change (the body
--- colour toggle) can repaint what is already on screen instead of applying only
--- to posts that happen to arrive afterwards.
---@type table[]
M.log = {}

--- The most recent boarding pass. Kept so the code can be yanked without going
--- to look for it: hunting it down in the feed parks the cursor in history, which
--- silently stops the feed following (found live, mid-mint).
---@type { code: string, lines: string[] }|nil
M.last_pass = nil

--- The rows the presence strip currently shows, index-aligned with its buffer
--- lines, so a cursor position can be turned back into a handle - or, below the
--- seats, into a decision (#295). Filler entries ({}) keep the alignment across
--- the placeholder, separator, and header lines.
---@type table[]
M.presence_rows = {}

--- The last roster the panel painted; kept so the decisions section can repaint
--- without waiting for the next roster event, and the other way around.
---@type table[]
M.seat_rows = {}

--- The decision ledger as last emitted by the engine (#295): the panel's
--- decisions section and its cursor map derive from this.
---@type table[]
M.decision_rows = {}
local PANEL_SETTLED_LINGER_MS = 5 * 60 * 1000
local settled_timer = nil

local function settled_epoch_ms(value)
  local year, month, day, hour, minute, second = value:match('^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+):(%d+)')
  if not year then return nil end
  local parsed = os.time({ year = tonumber(year), month = tonumber(month), day = tonumber(day),
    hour = tonumber(hour), min = tonumber(minute), sec = tonumber(second), isdst = false })
  local local_now = os.date('*t')
  local utc_now = os.date('!*t')
  local offset = os.difftime(os.time(local_now), os.time(utc_now))
  return (parsed + offset) * 1000
end

--- The armed decision (#295, ruled): set by selecting a decision row, cleared
--- one shot by the next plain message, by selecting all or any seat, or by
--- going back to the live feed. { id, ref } or nil.
---@type { id: string, ref: string }|nil
M.armed = nil

--- An engine question (ask/confirm) owns the next prompt line (#262): that line
--- is an ANSWER, so the armed decision must never consume it.
M.question_pending = false

--- Prompt history (#258): every submitted line, oldest first. Survives a console
--- restart within the nvim session (rebinding a room is the first thing recalled)
--- and is never written to disk.
---@type string[]
M.history = {}

--- Where a recall walk stands: nil = the live line; otherwise an index into
--- M.history. The draft is what was typed before the walk started, restored by
--- stepping past the newest entry.
local hist_pos = nil
local hist_draft = ''

--- Define the plugin's groups. Called at setup AND on every ColorScheme, because
--- :colorscheme clears highlights - including `default` links - so a scheme switch
--- mid-session would otherwise leave the whole feed rendering as Normal.
function M.apply_highlights()
  local link = function(group, to)
    vim.api.nvim_set_hl(0, group, { link = to, default = true })
  end
  -- Three tiers, not one. Everything used to be FlurryPortDim, which on a scheme
  -- like dracula collapsed info, listings, tags, times and ids into one wash.
  --   Info    the console talking to you           (distinct, readable)
  --   Slug    things you can paste back as a command (pops: they are actionable)
  --   Dim     metadata you scan past                (quiet: times, ids, tags)
  link('FlurryPortInfo', 'MoreMsg')
  link('FlurryPortSlug', 'Directory')
  link('FlurryPortDim', 'Comment')
  link('FlurryPortByline', 'Identifier')
  link('FlurryPortError', 'ErrorMsg')
  link('FlurryPortAsk', 'WarningMsg')
  link('FlurryPortVerb', 'Statement')
  link('FlurryPortTag', 'Comment')
  link('FlurryPortPanic', 'ErrorMsg')
  link('FlurryPortRed', 'DiagnosticError')
  link('FlurryPortGreen', 'DiagnosticOk')
  link('FlurryPortYellow', 'DiagnosticWarn')
  link('FlurryPortBlue', 'DiagnosticInfo')
  link('FlurryPortMagenta', 'Constant')
  link('FlurryPortCyan', 'Special')
  link('FlurryPortWhite', 'Normal')
  link('FlurryPortGray', 'Comment')
  link('FlurryPortPurple', 'Constant')
  link('FlurryPortOrange', 'Number')
  link('FlurryPortPink', 'Constant')
  link('FlurryPortTeal', 'Special')
end

---@param name string
---@return integer bufnr
local function scratch(name)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_set_name(buf, name)
  -- These buffers cannot be written (E382 on :wq) and the prompt swallows :q,
  -- so every read-only pane carries the plain nvim escape hatch: q closes.
  vim.keymap.set('n', 'q', function()
    require('flurryport').close()
  end, { buffer = buf, nowait = true, desc = 'close the FlurryPORT room' })
  return buf
end

--- Write lines into a buffer, applying each line's highlight spans.
---@param buf integer
---@param lines fp.Line[]
---@param append boolean
local function write(buf, lines, append)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  vim.bo[buf].modifiable = true
  -- start/stop are tracked SEPARATELY. The obvious `append and start or -1` is a
  -- trap: 0 is truthy in Lua, so the fresh-buffer case (start forced to 0) took
  -- the append branch and INSERTED before the blank line instead of replacing it,
  -- leaving a stray empty row at the end of the feed for the whole session.
  local start, stop
  if append then
    start = vim.api.nvim_buf_line_count(buf)
    stop = start
    -- A fresh scratch buffer counts one empty line; replace it rather than
    -- writing around it.
    if start == 1 and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == '' then
      start, stop = 0, -1
    end
  else
    start, stop = 0, -1
    vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  end

  -- nvim_buf_set_lines refuses items with embedded newlines (found live: the
  -- record picker's queue listing arrived as one multi-line feedback string and
  -- crashed the feed write). Flatten every line into physical rows here so any
  -- multi-line text renders; highlights ride the first row only, clamped.
  local flat = {}
  for _, l in ipairs(lines) do
    local first = true
    for seg in (l.text .. '\n'):gmatch('([^\n]*)\n') do
      table.insert(flat, { text = (seg:gsub('\r$', '')), hls = first and l.hls or nil })
      first = false
    end
  end

  local texts = {}
  for _, l in ipairs(flat) do
    table.insert(texts, l.text)
  end
  vim.api.nvim_buf_set_lines(buf, start, stop, false, texts)

  for i, l in ipairs(flat) do
    for _, hl in ipairs(l.hls or {}) do
      local row = start + i - 1
      pcall(vim.api.nvim_buf_set_extmark, buf, M.ns, row, hl.from, {
        end_col = hl.to == -1 and #l.text or math.min(hl.to, #l.text),
        hl_group = hl.group,
      })
    end
  end
  vim.bo[buf].modifiable = false
end

--- Was the reader parked at the newest line BEFORE this write? The question has to
--- be asked first: comparing the old cursor against the new line count silently
--- stops following as soon as a write is taller than the slack, which is every
--- listing (found live - a ten-row :list endpoints scrolled off and stayed off).
---@param win integer|nil
---@param buf integer
---@return boolean
local function at_bottom(win, buf)
  if not win or not vim.api.nvim_win_is_valid(win) then
    return false
  end
  if vim.api.nvim_win_get_buf(win) ~= buf then
    return false -- the window is showing an envoy buffer; leave it alone
  end
  return vim.api.nvim_win_get_cursor(win)[1] >= vim.api.nvim_buf_line_count(buf) - 1
end

--- Park on the newest line. Only called when the reader was already there, so
--- scrolling back through history is never yanked forward by an arriving post.
---@param win integer|nil
---@param buf integer
local function to_bottom(win, buf)
  if not win or not vim.api.nvim_win_is_valid(win) then
    return
  end
  if vim.api.nvim_win_get_buf(win) ~= buf then
    return
  end
  pcall(vim.api.nvim_win_set_cursor, win, { vim.api.nvim_buf_line_count(buf), 0 })
end

--- What is typed on the prompt line right now, prompt prefix stripped.
---@return string
local function prompt_text()
  if not M.buf.prompt or not vim.api.nvim_buf_is_valid(M.buf.prompt) then
    return ''
  end
  local prompt = vim.fn.prompt_getprompt(M.buf.prompt)
  local count = vim.api.nvim_buf_line_count(M.buf.prompt)
  local last = vim.api.nvim_buf_get_lines(M.buf.prompt, count - 1, count, false)[1] or ''
  return last:sub(#prompt + 1)
end

--- Replace the prompt line's typed text, cursor parked at the end.
---@param text string
local function set_prompt_text(text)
  if not M.buf.prompt or not vim.api.nvim_buf_is_valid(M.buf.prompt) then
    return
  end
  local prompt = vim.fn.prompt_getprompt(M.buf.prompt)
  local count = vim.api.nvim_buf_line_count(M.buf.prompt)
  vim.api.nvim_buf_set_lines(M.buf.prompt, count - 1, count, false, { prompt .. text })
  if M.win.prompt and vim.api.nvim_win_is_valid(M.win.prompt) then
    pcall(vim.api.nvim_win_set_cursor, M.win.prompt, { count, #prompt + #text })
  end
end

--- Record a submitted line (#258) and land any recall walk. Empty lines and
--- immediate repeats are not worth recalling.
---@param line string
function M.history_push(line)
  hist_pos = nil
  hist_draft = ''
  if line and line ~= '' and M.history[#M.history] ~= line then
    table.insert(M.history, line)
  end
end

--- <Up>: recall, newest first. The first step stashes the live line as the draft.
function M.history_prev()
  if #M.history == 0 then
    return
  end
  if hist_pos == nil then
    hist_draft = prompt_text()
    hist_pos = #M.history
  elseif hist_pos > 1 then
    hist_pos = hist_pos - 1
  else
    return
  end
  set_prompt_text(M.history[hist_pos])
end

--- <Down>: walk back toward the live line; past the newest entry the draft returns.
function M.history_next()
  if hist_pos == nil then
    return
  end
  if hist_pos < #M.history then
    hist_pos = hist_pos + 1
    set_prompt_text(M.history[hist_pos])
  else
    hist_pos = nil
    set_prompt_text(hist_draft)
    hist_draft = ''
  end
end

---@param on_submit fun(line: string)
function M.open(on_submit)
  M.apply_highlights()

  vim.cmd('tabnew')
  M.buf.feed = scratch('flurryport://feed')
  M.win.feed = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(M.win.feed, M.buf.feed)
  vim.wo[M.win.feed].wrap = true
  vim.wo[M.win.feed].linebreak = true
  vim.wo[M.win.feed].breakindent = true
  vim.wo[M.win.feed].number = false
  vim.wo[M.win.feed].relativenumber = false

  -- presence: a narrow pinned column on the right. `rightbelow` is not optional -
  -- a bare :vsplit honors the user's 'splitright', so the layout would mirror
  -- itself depending on their config (found immediately on the first real run).
  vim.cmd('rightbelow vsplit')
  M.win.presence = vim.api.nvim_get_current_win()
  M.buf.presence = scratch('flurryport://presence')
  vim.api.nvim_win_set_buf(M.win.presence, M.buf.presence)
  -- No fixed width (#260): set_presence below sizes the panel to its content,
  -- and re-sizes it on every repaint.
  vim.wo[M.win.presence].number = false
  vim.wo[M.win.presence].relativenumber = false
  vim.wo[M.win.presence].winfixwidth = true

  -- prompt: one line at the bottom, spanning the tab
  vim.api.nvim_set_current_win(M.win.feed)
  -- botright already ignores 'splitbelow', but be explicit about the height too.
  vim.cmd('botright split')
  M.win.prompt = vim.api.nvim_get_current_win()
  M.buf.prompt = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(M.win.prompt, M.buf.prompt)
  vim.api.nvim_win_set_height(M.win.prompt, 3)
  vim.bo[M.buf.prompt].buftype = 'prompt'
  vim.bo[M.buf.prompt].swapfile = false
  vim.api.nvim_buf_set_name(M.buf.prompt, 'flurryport://prompt')
  vim.fn.prompt_setprompt(M.buf.prompt, '> ')
  vim.fn.prompt_setcallback(M.buf.prompt, function(line)
    M.clear_pending() -- whatever question owned this line has its answer (#262)
    M.history_push(line) -- the TYPED line: recall must recall what was typed
    on_submit(M.route_line(line))
  end)
  vim.wo[M.win.prompt].number = false
  vim.wo[M.win.prompt].relativenumber = false
  vim.wo[M.win.prompt].winfixheight = true
  -- Shell-style recall (#258): <Up> walks submitted lines newest first, <Down>
  -- walks back and past the newest restores what was being typed. Session only.
  hist_pos, hist_draft = nil, ''
  vim.keymap.set('i', '<Up>', M.history_prev, { buffer = M.buf.prompt, desc = 'recall an earlier prompt line' })
  vim.keymap.set('i', '<Down>', M.history_next, { buffer = M.buf.prompt, desc = 'walk recall back toward the live line' })

  -- Enter on a name in the roster opens that seat's thread. <C-w>l to the strip,
  -- move to a name, Enter: no handle to remember and no command to type. Enter
  -- on a decision row (#295) opens that decision's thread and ARMS it as the
  -- reply target; the ONE selection model is Gene's ruling verbatim - selecting
  -- all, or any actor, unselects the decision.
  vim.keymap.set('n', '<CR>', function()
    if not M.win.presence or not vim.api.nvim_win_is_valid(M.win.presence) then
      return
    end
    local row = M.presence_rows[vim.api.nvim_win_get_cursor(M.win.presence)[1]] or {}
    if row.decision then
      M.open_decision(row.decision)
    elseif row.decision_clear then
      -- `none` is the decisions twin of `all` (#295): drop the selection
      -- without picking anything else.
      M.clear_decision()
    elseif row.full_roster then
      -- `all` means back to the room; show_feed also parks the live edge on the
      -- newest post (and drops any armed decision) and is deliberately harmless
      -- when the full feed is open.
      M.show_feed()
    elseif row.handle then
      M.disarm()
      M.open_envoy(row.handle)
    end
  end, { buffer = M.buf.presence, nowait = true, desc = "open this seat's thread or this decision's record" })

  M.set_presence({})
  vim.api.nvim_set_current_win(M.win.prompt)
  vim.cmd('startinsert')
end

function M.is_open()
  return M.buf.feed ~= nil and vim.api.nvim_buf_is_valid(M.buf.feed)
end

--- Pin a pending-answer marker on the prompt (#262): an ask or confirm owns the
--- NEXT prompt line, and that fact must be visible where the typing happens.
---@param marker string
function M.set_pending(marker)
  if not M.buf.prompt or not vim.api.nvim_buf_is_valid(M.buf.prompt) then
    return
  end
  vim.api.nvim_buf_clear_namespace(M.buf.prompt, M.ns, 0, -1)
  local row = vim.api.nvim_buf_line_count(M.buf.prompt) - 1
  pcall(vim.api.nvim_buf_set_extmark, M.buf.prompt, M.ns, row, 0, {
    virt_text = { { marker, 'FlurryPortAsk' } },
    virt_text_pos = 'eol',
  })
end

--- The next line was submitted: whatever question owned it is answered now.
function M.clear_pending()
  if M.buf.prompt and vim.api.nvim_buf_is_valid(M.buf.prompt) then
    vim.api.nvim_buf_clear_namespace(M.buf.prompt, M.ns, 0, -1)
  end
end

---@param event table
function M.push(event)
  if not M.is_open() then
    return
  end
  if event.type == 'pairing' then
    M.last_pass = { code = event.code, lines = event.passLines or {} }
  end
  -- A question must never render invisibly (#262): the engine reserves the next
  -- prompt line for the answer, but the question paints into the feed BUFFER,
  -- and if the feed window is showing a thread that buffer is hidden (found
  -- live: a revoke confirm from a thread view showed nothing at all). Force the
  -- live feed first, and pin the marker until the answer is submitted.
  if event.type == 'ask' or event.type == 'confirm' then
    -- A question forcing the live feed is not the chair leaving: the armed
    -- decision (#295) survives show_feed's disarm, and question_pending keeps
    -- the answer line out of the armed target's one shot.
    local armed = M.armed
    M.show_feed()
    M.armed = armed
    M.question_pending = true
    M.set_pending(event.type == 'confirm' and '[y/N waiting]' or '[answer waiting]')
  end
  if event.type == 'feed' then
    table.insert(M.items, event.item)
    -- A live row joins an open thread only if it belongs to it: that seat, or the
    -- chair, whose side is half the conversation.
    for handle, envoy in pairs(M.buf.envoys) do
      if vim.api.nvim_buf_is_valid(envoy) and (M.is_from(event.item, handle) or event.item.mine) then
        write(envoy, render.event(event), true)
      end
    end
    -- A decision thread (#295) grows the same way: the proposal's own record.
    for id, buf in pairs(M.buf.decisions) do
      if vim.api.nvim_buf_is_valid(buf) and M.in_decision(event.item, id) then
        write(buf, render.event(event), true)
      end
    end
    -- Disposition clears the selection (#295, word-ratified): an fp:ratify,
    -- fp:retract, or fp:strike landing on the log re-linked to the armed
    -- decision drops the selection, exactly as the none row does. The echo IS
    -- the went-through signal: a refused act never reaches the log, so the
    -- selection holds. Checked after the thread writes above, so the ruling
    -- row joins the record before a decision thread returns to live.
    local verb = event.item.verb
    if M.armed and type(verb) == 'table'
      and (verb.raw == 'fp:ratify' or verb.raw == 'fp:retract' or verb.raw == 'fp:strike')
      and M.in_decision(event.item, M.armed.id) then
      M.clear_decision()
    end
  end
  table.insert(M.log, event)
  local lines = render.event(event)
  if #lines > 0 then
    local following = at_bottom(M.win.feed, M.buf.feed)
    write(M.buf.feed, lines, true)
    if following then
      to_bottom(M.win.feed, M.buf.feed)
    end
  end
end

--- The presence panel's width for these rendered lines (#260): fit the longest
--- roster row (handle, state, posts, and the two-column margin all live in the
--- rendered text), floored at the empty-roster line, capped at 40 columns or a
--- third of the screen, whichever is smaller. The cap wins over the floor on a
--- terminal too narrow for both.
---@param lines fp.Line[]
---@return integer
local function presence_width(lines)
  local widest = 0
  for _, l in ipairs(lines) do
    widest = math.max(widest, vim.fn.strdisplaywidth(l.text))
  end
  local floor = vim.fn.strdisplaywidth(render.EMPTY_ROSTER)
  local cap = math.min(40, math.floor(vim.o.columns / 3))
  return math.min(math.max(widest, floor), cap)
end

--- Repaint the whole panel: the seat rows, then the decisions section under
--- them (#295) - ONE buffer, one width fit, one cursor map. presence_rows stays
--- index-aligned with every painted line; filler entries ({}) stand in for the
--- placeholder, separator, and header lines so Enter on them does nothing.
local function paint_panel()
  if not M.is_open() then
    return
  end
  local lines = render.presence(M.seat_rows)
  M.presence_rows = { { handle = render.ALL_ROSTER, full_roster = true } }
  for _, row in ipairs(M.seat_rows) do
    table.insert(M.presence_rows, row)
  end
  while #M.presence_rows < #lines do
    table.insert(M.presence_rows, {})
  end
  local visible_decisions = {}
  local now = os.time() * 1000
  for _, row in ipairs(M.decision_rows) do
    if row.state == 'needs-ratification' or not row.settledAt then
      table.insert(visible_decisions, row)
    else
      local settled = settled_epoch_ms(row.settledAt)
      local expiry = settled + PANEL_SETTLED_LINGER_MS
      if expiry > now then
        table.insert(visible_decisions, row)
      end
    end
  end
  for _, l in ipairs(render.decisions(visible_decisions)) do
    table.insert(lines, l)
    table.insert(M.presence_rows,
      l.decision and { decision = l.decision }
      or l.decision_clear and { decision_clear = true }
      or {})
  end
  write(M.buf.presence, lines, false)
  -- Recomputed on every repaint: seats and decisions come and go, and so does
  -- their width (#260). winfixwidth stays set, so window equalization never
  -- undoes the fit.
  if M.win.presence and vim.api.nvim_win_is_valid(M.win.presence) then
    vim.api.nvim_win_set_width(M.win.presence, presence_width(lines))
  end
end

local function schedule_settled_fade()
  if settled_timer then
    settled_timer:stop()
    settled_timer:close()
    settled_timer = nil
  end
  local now = os.time() * 1000
  local next_expiry = nil
  for _, row in ipairs(M.decision_rows) do
    if row.state ~= 'needs-ratification' and row.settledAt then
      local settled = settled_epoch_ms(row.settledAt)
      local expiry = settled + PANEL_SETTLED_LINGER_MS
      if expiry > now then next_expiry = next_expiry and math.min(next_expiry, expiry) or expiry end
    end
  end
  if next_expiry then
    settled_timer = vim.uv.new_timer()
    settled_timer:start(math.max(1, next_expiry - now), 0, vim.schedule_wrap(function()
      settled_timer:stop()
      settled_timer:close()
      settled_timer = nil
      paint_panel()
      schedule_settled_fade()
    end))
  end
end

---@param rows table[]
function M.set_presence(rows)
  M.seat_rows = rows or {}
  paint_panel()
end

--- The decisions event's rows (#295), straight off the engine. The panel is a
--- render of the engine's derived ledger, never a second ledger.
---@param rows table[]
function M.set_decisions(rows)
  M.decision_rows = rows or {}
  paint_panel()
  schedule_settled_fade()
end

--- The handle on the presence line under the cursor, nil on the empty placeholder.
--- Line one is the synthetic `all` row; the following lines map to seats.
---@return string|nil
function M.handle_under_cursor()
  if not M.win.presence or not vim.api.nvim_win_is_valid(M.win.presence) then
    return nil
  end
  local row = M.presence_rows[vim.api.nvim_win_get_cursor(M.win.presence)[1]]
  return row and row.handle or nil
end

--- Does this feed row belong to `handle`? Byline dedup renders either the bare
--- handle or "Guest Name (handle)", so both forms count.
---@param item table
---@param handle string
---@return boolean
function M.is_from(item, handle)
  local byline = item.byline or ''
  return byline == handle or byline:sub(-(#handle + 2)) == ('(' .. handle .. ')')
end

--- One seat's thread: that seat AND the chair, so it reads as a conversation
--- rather than a monologue. Filtering the chair out would leave every answer
--- without its question.
---@param handle string
function M.open_envoy(handle)
  local match = {
    { text = '  -- ' .. handle .. ' and the chair -- (:FlurryPORT feed for live)',
      hls = { { group = 'FlurryPortInfo', from = 0, to = -1 } } },
  }
  for _, item in ipairs(M.items) do
    if M.is_from(item, handle) or item.mine then
      for _, l in ipairs(render.event({ type = 'feed', item = item })) do
        table.insert(match, l)
      end
    end
  end

  local buf = M.buf.envoys[handle]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = scratch('flurryport://envoy/' .. handle)
    -- q in a THREAD steps back to the live feed (#261). scratch() maps q to
    -- close-the-room on every read-only pane, which is right for the feed and
    -- the roster, but a thread is one level down: q there tore down the whole
    -- room and dropped every seated agent (found live). Override per buffer.
    vim.keymap.set('n', 'q', function()
      M.show_feed()
    end, { buffer = buf, nowait = true, desc = 'back to the live feed' })
    M.buf.envoys[handle] = buf
  end
  if #match == 1 then
    table.insert(match, { text = '  nothing from ' .. handle .. ' yet', hls = {} })
  end
  write(buf, match, false)

  vim.api.nvim_set_current_win(M.win.feed)
  vim.api.nvim_win_set_buf(M.win.feed, buf)
end

--- Back to the live feed from an envoy or decision buffer. Going back to live
--- also drops any armed decision (#295, ruled): the reply target belongs to the
--- thread the chair was just looking at.
function M.show_feed()
  M.disarm()
  if M.is_open() and M.win.feed and vim.api.nvim_win_is_valid(M.win.feed) then
    vim.api.nvim_win_set_buf(M.win.feed, M.buf.feed)
    -- Coming back from an envoy buffer always lands on the newest line: that is
    -- what "back to live" means.
    to_bottom(M.win.feed, M.buf.feed)
  end
end

-- ── the decisions section's other half (#295): threads and the armed target ──

--- Does this feed row belong to the decision's thread? The proposal post
--- itself, plus every post re-linked to it. Wire re values may carry a shorter
--- reference for the same post, so the engine's prefix leniency is mirrored at
--- the id-floor.
---@param item table
---@param id string
---@return boolean
function M.in_decision(item, id)
  if item.id == id then
    return true
  end
  local re = item.re
  if type(re) ~= 'string' or re == '' then
    return false
  end
  return re == id or (#re >= render.ID_PREFIX_FLOOR and id:sub(1, #re) == re)
end

--- The clear row's Enter (#295, Gene's order): disarm, and return a DECISION
--- thread to live (the #276 back-to-live contract). A seat thread stays put -
--- the row clears the decision selection, and a seat thread never was one, so
--- yanking the chair out of it would be the row doing more than it says.
function M.clear_decision()
  M.disarm()
  if not (M.win.feed and vim.api.nvim_win_is_valid(M.win.feed)) then
    return
  end
  local showing = vim.api.nvim_win_get_buf(M.win.feed)
  for _, buf in pairs(M.buf.decisions) do
    if buf == showing then
      M.show_feed()
      return
    end
  end
end

--- Drop the armed decision and its prompt marker.
function M.disarm()
  if M.armed then
    M.armed = nil
    M.clear_pending()
  end
end

--- One decision's thread (#295, ruled): the proposal post plus every post
--- re-linked to it - replies, the ruling, a retract - chronological, in the
--- feed window, the seat-thread mechanics exactly (#276: q or Enter on all
--- returns to live). Opening it also ARMS the decision: the next plain prompt
--- line posts re-linked to it, one shot.
---@param dec table
function M.open_decision(dec)
  M.armed = { id = dec.id, ref = dec.ref }
  M.set_pending('[re ' .. dec.ref .. ']')
  local match = {
    { text = '  -- decision ' .. dec.ref .. ': ' .. render.decision_words(dec.summary)
        .. ' -- (:FlurryPORT feed for live)',
      hls = { { group = 'FlurryPortInfo', from = 0, to = -1 } } },
  }
  for _, item in ipairs(M.items) do
    if M.in_decision(item, dec.id) then
      for _, l in ipairs(render.event({ type = 'feed', item = item })) do
        table.insert(match, l)
      end
    end
  end

  local buf = M.buf.decisions[dec.id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = scratch('flurryport://decision/' .. dec.ref)
    -- q steps back to the live feed, the thread contract (#261), which also
    -- disarms - leaving the thread is leaving the reply target.
    vim.keymap.set('n', 'q', function()
      M.show_feed()
    end, { buffer = buf, nowait = true, desc = 'back to the live feed' })
    M.buf.decisions[dec.id] = buf
  end
  if #match == 1 then
    table.insert(match, { text = '  nothing on the record for ' .. dec.ref .. ' yet', hls = {} })
  end
  write(buf, match, false)

  vim.api.nvim_set_current_win(M.win.feed)
  vim.api.nvim_win_set_buf(M.win.feed, buf)
end

--- Route one submitted prompt line through the armed decision (#295): the next
--- PLAIN message is rewritten to the console's explicit reply form and the
--- target clears - one shot. A chair verb line (anything : led) passes through
--- untouched and KEEPS the armed target; a line answering an engine question
--- is an answer, never a message. Returns what the console should receive.
---@param line string
---@return string
function M.route_line(line)
  if M.question_pending then
    M.question_pending = false
    if M.armed then
      M.set_pending('[re ' .. M.armed.ref .. ']') -- the marker outlives the answered question
    end
    return line
  end
  if not M.armed or line == '' then
    return line
  end
  if line:sub(1, 1) == ':' then
    -- Selection-aware record verbs (#295, ratified): with a decision armed, a
    -- bare :ratify gavels THAT decision and a bare :retract nulls it - the line
    -- rewrites to the explicit-ref form before the engine sees it, so the
    -- engine's ratify-all y/N prompt appears only when nothing is armed. The
    -- selection holds until the disposition echoes back off the log (push
    -- drops it then); a refused act never echoes, so the selection survives.
    local head = line:match('^:(%a+)%s*$')
    if head == 'ratify' or head == 'retract' then
      M.set_pending('[re ' .. M.armed.ref .. ']')
      return ':' .. head .. ' ' .. M.armed.ref
    end
    -- clear_pending ran at submit; a verb line keeps the target, so re-pin.
    M.set_pending('[re ' .. M.armed.ref .. ']')
    return line
  end
  local ref = M.armed.ref
  M.armed = nil
  return ':re ' .. ref .. ' ' .. line
end

--- The console died (or was exited from the prompt). Input is now meaningless, so
--- the prompt window goes away rather than silently swallowing what is typed into
--- it - the feed and roster stay readable, and `q` closes the rest.
function M.orphan()
  if M.win.prompt and vim.api.nvim_win_is_valid(M.win.prompt) then
    pcall(vim.api.nvim_win_close, M.win.prompt, true)
  end
  M.win.prompt = nil
  M.buf.prompt = nil
  if M.win.feed and vim.api.nvim_win_is_valid(M.win.feed) then
    pcall(vim.api.nvim_set_current_win, M.win.feed)
  end
end

--- Put the latest boarding pass where it can be pasted: the unnamed register and,
--- when the platform has one, the system clipboard.
---@return string|nil code
function M.yank_pass()
  if not M.last_pass then
    return nil
  end
  local blob = table.concat(M.last_pass.lines, '\n')
  if blob == '' then
    blob = M.last_pass.code
  end
  vim.fn.setreg('"', blob)
  pcall(vim.fn.setreg, '+', blob)
  return M.last_pass.code
end

--- Re-render the whole feed from the log. Keeps the reader where they were unless
--- they were parked on the newest line, in which case they stay parked there.
function M.repaint()
  if not M.is_open() then
    return
  end
  local following = at_bottom(M.win.feed, M.buf.feed)
  local where = M.win.feed and vim.api.nvim_win_is_valid(M.win.feed)
    and vim.api.nvim_win_get_cursor(M.win.feed)[1] or 1
  local lines = {}
  for _, event in ipairs(M.log) do
    for _, l in ipairs(render.event(event)) do
      table.insert(lines, l)
    end
  end
  write(M.buf.feed, lines, false)
  if following then
    to_bottom(M.win.feed, M.buf.feed)
  elseif M.win.feed and vim.api.nvim_win_is_valid(M.win.feed) then
    pcall(vim.api.nvim_win_set_cursor, M.win.feed,
      { math.min(where, vim.api.nvim_buf_line_count(M.buf.feed)), 0 })
  end
end

function M.close()
  if settled_timer then
    settled_timer:stop()
    settled_timer:close()
    settled_timer = nil
  end
  for _, win in pairs(M.win) do
    if win and vim.api.nvim_win_is_valid(win) then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
  M.win = { feed = nil, presence = nil, prompt = nil }
  M.buf = { feed = nil, presence = nil, prompt = nil, envoys = {}, decisions = {} }
  M.items = {}
  M.seat_rows = {}
  M.decision_rows = {}
  M.armed = nil
  M.question_pending = false
  render.reset_ids()

--- Every event the feed has shown, in order. Kept so a display change (the body
--- colour toggle) can repaint what is already on screen instead of applying only
--- to posts that happen to arrive afterwards.
---@type table[]
M.log = {}

--- The most recent boarding pass. Kept so the code can be yanked without going
--- to look for it: hunting it down in the feed parks the cursor in history, which
--- silently stops the feed following (found live, mid-mint).
---@type { code: string, lines: string[] }|nil
M.last_pass = nil

--- The rows the presence strip currently shows, index-aligned with its buffer
--- lines, so a cursor position can be turned back into a handle.
---@type table[]
M.presence_rows = {}
end

return M
