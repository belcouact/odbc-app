import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import AddIcon from '@mui/icons-material/Add'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined'
import GridViewIcon from '@mui/icons-material/GridView'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined'
import ReplayIcon from '@mui/icons-material/Replay'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import SendIcon from '@mui/icons-material/Send'
import ThumbUpIcon from '@mui/icons-material/ThumbUp'
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined'
import ViewListIcon from '@mui/icons-material/ViewList'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import InputAdornment from '@mui/material/InputAdornment'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Skeleton from '@mui/material/Skeleton'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { alpha, useTheme } from '@mui/material/styles'
import { api } from '../api/client'
import type {
  FeedbackAttachment,
  FeedbackCategory,
  FeedbackProfile,
  FeedbackReply,
  FeedbackSort,
  FeedbackStatus,
  FeedbackThread,
  FeedbackThreadDetail,
} from '../api/client'

/** How often the open board re-fetches while the tab is visible. */
const POLL_INTERVAL_MS = 20000
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Mirrors the backend allow-list so a bad pick fails before the upload. */
const ATTACHMENT_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.pdf', '.txt', '.log', '.csv', '.json', '.xlsx', '.xls', '.zip',
]
const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.join(',')

/** The board is one workspace: full-bleed bands, centred content, square corners. */
const PAGE_MAX_WIDTH = 1200
const PAGE_GUTTER = { xs: 1.5, sm: 2, md: 3 }

type CategoryColor = 'error' | 'warning' | 'info' | 'default'

const CATEGORY_META: { value: FeedbackCategory; label: string; color: CategoryColor }[] = [
  { value: 'bug', label: 'Bug', color: 'error' },
  { value: 'idea', label: 'Idea', color: 'warning' },
  { value: 'question', label: 'Question', color: 'info' },
  { value: 'other', label: 'Other', color: 'default' },
]

const SORT_OPTIONS: { value: FeedbackSort; label: string }[] = [
  { value: 'recent', label: 'Latest activity' },
  { value: 'newest', label: 'Newest first' },
  { value: 'top', label: 'Most liked' },
]

type Notice = { severity: 'success' | 'error' | 'info'; message: string } | null

function categoryMeta(value: FeedbackCategory) {
  return CATEGORY_META.find((entry) => entry.value === value) ?? CATEGORY_META[3]
}

/** "3 minutes ago" style timestamp, falling back to a date after a week. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const minute = 60000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < 0) return new Date(then).toLocaleString()
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(then).toLocaleDateString()
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImage(attachment: FeedbackAttachment): boolean {
  if (attachment.type.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name || attachment.url)
}

/**
 * A pasted screenshot arrives as an anonymous blob (or a generic "image.png"),
 * which would read as three identical rows in a thread, so give it a name that
 * says when it was taken.
 */
function nameForUpload(file: File): File {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
  if (!generic) return file
  const fromName = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  const extension = fromName || (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  return new File([file], `screenshot-${stamp}.${extension}`, { type: file.type })
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unexpected error'
}

/** Author line: nickname (or "Anonymous"), app version, timestamp. */
function AuthorLine({ name, version, at }: { name: string; version: string; at: string }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
      {name || 'Anonymous'}
      {version ? ` · v${version}` : ''}
      {at ? ` · ${relativeTime(at)}` : ''}
    </Typography>
  )
}

/** Attachments of a post: image thumbnails, other files as links.
 *  `large` sizes images for the discussion view, where a screenshot is the
 *  content — a 132px thumbnail is unreadable there, so images stretch to the
 *  column width (capped) instead of a fixed mini tile. */
function AttachmentList({
  attachments,
  large = false,
}: {
  attachments: FeedbackAttachment[]
  large?: boolean
}) {
  if (attachments.length === 0) return null
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 1.5 }}>
      {attachments.map((attachment) =>
        isImage(attachment) ? (
          <Box
            key={attachment.url}
            component="a"
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${attachment.name} — open in a new tab`}
            sx={{
              display: 'block',
              lineHeight: 0,
              borderRadius: 1.5,
              overflow: 'hidden',
              border: '1px solid',
              borderColor: 'divider',
              ...(large && { maxWidth: { xs: '100%', sm: 560 } }),
            }}
          >
            <Box
              component="img"
              src={attachment.url}
              alt={attachment.name}
              loading="lazy"
              sx={
                large
                  ? {
                      width: '100%',
                      height: 'auto',
                      maxHeight: { xs: 300, md: 420 },
                      objectFit: 'contain',
                      bgcolor: '#ffffff',
                    }
                  : { width: { xs: 96, sm: 132 }, height: { xs: 72, sm: 96 }, objectFit: 'cover' }
              }
            />
          </Box>
        ) : (
          <Chip
            key={attachment.url}
            component="a"
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            clickable
            variant="outlined"
            icon={<InsertDriveFileOutlinedIcon />}
            label={`${attachment.name}${attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}`}
            sx={{ maxWidth: '100%' }}
          />
        ),
      )}
    </Box>
  )
}

/** Pick or paste files for a post that is still being written. */
function AttachmentField({
  attachments,
  onChange,
  onNotice,
  disabled,
  action,
}: {
  attachments: FeedbackAttachment[]
  onChange: (next: FeedbackAttachment[]) => void
  onNotice: (notice: Notice) => void
  disabled?: boolean
  /** Optional control pinned to the right of the attach row, e.g. "Reply". */
  action?: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<number | null>(null)

  /** Validate and upload one file, returning null when it was rejected. */
  const uploadOne = async (file: File): Promise<FeedbackAttachment | null> => {
    // A clipboard image is nameless (or a generic "image.png"), so normalise it
    // first — the allow-list check below reads the extension off the name.
    const normalised = nameForUpload(file)
    const extension = normalised.name.slice(normalised.name.lastIndexOf('.')).toLowerCase()
    if (!ATTACHMENT_EXTENSIONS.includes(extension)) {
      onNotice({ severity: 'error', message: 'Unsupported file type.' })
      return null
    }
    if (normalised.size > MAX_ATTACHMENT_BYTES) {
      onNotice({ severity: 'error', message: 'Attachments are limited to 10 MB each.' })
      return null
    }
    setUploading(0)
    try {
      return await api.uploadFeedbackAttachment(normalised, setUploading)
    } catch (error) {
      onNotice({ severity: 'error', message: errorText(error) })
      return null
    } finally {
      setUploading(null)
    }
  }

  /** Upload a batch — one paste can carry more than a single image. */
  const addFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      onNotice({ severity: 'error', message: `Up to ${MAX_ATTACHMENTS} attachments per post.` })
      return
    }
    if (files.length > room) {
      onNotice({
        severity: 'info',
        message: `Only the first ${room} of ${files.length} files were added.`,
      })
    }
    const uploaded: FeedbackAttachment[] = []
    for (const file of files.slice(0, room)) {
      const result = await uploadOne(file)
      if (result) uploaded.push(result)
    }
    if (uploaded.length > 0) onChange([...attachments, ...uploaded])
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void addFiles([file])
  }

  // A pasted screenshot arrives wherever focus happens to be — usually the text
  // field beside this component — so listen on the document. Registered without a
  // dependency list on purpose: the guard below has to see the current upload
  // state, and the listener only exists while this field is mounted in a dialog.
  useEffect(() => {
    if (disabled) return
    const handlePaste = (event: ClipboardEvent) => {
      if (uploading !== null) return
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      )
      if (images.length === 0) return
      void addFiles(images)
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  })

  return (
    <Box>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={ATTACHMENT_ACCEPT}
        onChange={handleChange}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Button
          color="inherit"
          variant="outlined"
          startIcon={<AttachFileIcon />}
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading !== null || attachments.length >= MAX_ATTACHMENTS}
          sx={{ minHeight: 48 }}
        >
          Attach file
        </Button>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: '1 1 auto', minWidth: 0 }}
        >
          Paste a screenshot, or attach up to {MAX_ATTACHMENTS} files — 10 MB each.
        </Typography>
        {action}
      </Box>
      {uploading !== null && (
        <LinearProgress
          variant="determinate"
          value={uploading}
          sx={{ mt: 1, borderRadius: 1 }}
        />
      )}
      {attachments.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          {attachments.map((attachment) => (
            <Chip
              key={attachment.url}
              icon={isImage(attachment) ? <ImageOutlinedIcon /> : <InsertDriveFileOutlinedIcon />}
              label={`${attachment.name}${attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}`}
              onDelete={
                disabled ? undefined : () =>
                  onChange(attachments.filter((item) => item.url !== attachment.url))
              }
              variant="outlined"
              sx={{ maxWidth: '100%' }}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

/** Category pill, shared by every board layout. */
function CategoryChip({ category }: { category: FeedbackCategory }) {
  const meta = categoryMeta(category)
  return <Chip label={meta.label} color={meta.color} size="small" variant="outlined" />
}

/**
 * Status pill. A table needs a value in every cell, so list view prints "Open"
 * too; the roomier layouts stay quiet and only flag what is outstanding.
 */
function StatusChip({ status }: { status: FeedbackStatus }) {
  return status === 'resolved' ? (
    <Chip label="Resolved" size="small" color="success" icon={<CheckCircleOutlinedIcon />} />
  ) : (
    <Chip label="Open" size="small" variant="outlined" />
  )
}

/** Quiet paperclip noting how many files a post carries. */
function AttachmentCount({ attachments }: { attachments: FeedbackAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <Tooltip
      title={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
    >
      <AttachFileIcon fontSize="small" color="disabled" />
    </Tooltip>
  )
}

/**
 * Geometry shared by the two counters that close a card — the "same problem"
 * vote and the reply count. Identical height, pill radius, icon size and gap,
 * so they read as one cluster instead of a button beside a stray chip. Only the
 * colour separates them: the vote is actionable, the reply count is not.
 */
const COUNTER_SX = {
  // The theme pins every Button to a 44px minimum, so the shared box has to be
  // a min-height — a plain `height` would lose to it.
  minHeight: { xs: 40, sm: 32 },
  minWidth: 56,
  px: 1.25,
  borderRadius: 999,
  border: '1px solid',
  borderColor: 'text.disabled',
  flexShrink: 0,
  fontSize: 13,
  fontWeight: 600,
  '& svg': { fontSize: 18 },
} as const

/**
 * The "same problem" vote. Boxed on a card, where it is the main action; a bare
 * icon-and-count on a table row, where it fills in once you have voted.
 */
function VoteButton({
  thread,
  pending,
  dense = false,
  onToggle,
}: {
  thread: FeedbackThread
  pending: boolean
  dense?: boolean
  onToggle: () => void
}) {
  const variant = thread.liked_by_me ? 'contained' : dense ? 'text' : 'outlined'
  return (
    <Button
      size="small"
      variant={variant}
      color={thread.liked_by_me ? 'primary' : 'inherit'}
      aria-pressed={thread.liked_by_me}
      aria-label={`Same problem — ${thread.like_count} ${thread.like_count === 1 ? 'vote' : 'votes'}`}
      startIcon={
        pending ? (
          <CircularProgress size={14} color="inherit" />
        ) : thread.liked_by_me ? (
          <ThumbUpIcon />
        ) : (
          <ThumbUpOutlinedIcon />
        )
      }
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      disabled={pending}
      sx={
        dense
          ? {
              flexShrink: 0,
              minWidth: 0,
              minHeight: 32,
              px: 0.75,
              // The count keeps its slot while a vote is in flight, so the row
              // never reflows under the pointer.
              '& .MuiButton-startIcon': { mr: 0.5 },
            }
          : { ...COUNTER_SX, '& .MuiButton-startIcon': { ml: 0, mr: 0.5 } }
      }
    >
      {thread.like_count}
    </Button>
  )
}

/** One entry in the board: a full card, or a dense row in list view. */
function ThreadCard({
  thread,
  active,
  compact = false,
  onOpen,
  onToggleLike,
  likePending,
}: {
  thread: FeedbackThread
  active: boolean
  /** Dense single-entry row instead of the full card. */
  compact?: boolean
  onOpen: () => void
  onToggleLike: () => void
  likePending: boolean
}) {
  const meta = categoryMeta(thread.category)
  const statusChip = thread.status === 'resolved' ? <StatusChip status={thread.status} /> : null
  const replyChip = (
    <Chip
      size="small"
      variant="outlined"
      icon={<ForumOutlinedIcon />}
      label={thread.reply_count}
      aria-label={`${thread.reply_count} ${thread.reply_count === 1 ? 'reply' : 'replies'}`}
      sx={{
        ...COUNTER_SX,
        // Read-only twin of the vote pill: same box, quieter ink.
        color: 'text.secondary',
        '& .MuiChip-icon': { ml: 0, mr: 0.5, color: 'inherit' },
        '& .MuiChip-label': { px: 0, fontSize: 13, fontWeight: 600, color: 'inherit' },
      }}
    />
  )
  const voteButton = (
    <VoteButton
      thread={thread}
      pending={likePending}
      onToggle={onToggleLike}
    />
  )
  const title = (
    <Typography
      variant="subtitle2"
      noWrap={compact}
      sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0, lineHeight: 1.4 }}
    >
      {thread.title}
    </Typography>
  )
  const byline = (
    <AuthorLine name={thread.author_name} version={thread.app_version} at={thread.created_at} />
  )

  return (
    <Paper
      variant="outlined"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      aria-label={`${meta.label} feedback, ${thread.status}: ${thread.title}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      sx={{
        p: compact ? { xs: 1.25, sm: 1 } : { xs: 1.5, sm: 2 },
        cursor: 'pointer',
        // The accent rail is always laid out, so selecting a card never shifts
        // the text inside it.
        borderLeft: '3px solid',
        borderLeftColor: active ? 'primary.main' : 'transparent',
        borderColor: active ? 'primary.main' : 'divider',
        bgcolor: active ? alpha('#d97757', 0.05) : 'background.paper',
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        // Hover is a desktop affordance only; touch devices keep the resting style.
        '@media (hover: hover)': {
          '&:hover': { borderColor: 'primary.main', boxShadow: 2 },
        },
      }}
    >
      {compact ? (
        // List view on a phone: the title leads, the metadata and counters ride
        // below, and the description is left to the post itself.
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {title}
            <CategoryChip category={thread.category} />
            {statusChip}
          </Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              mt: 0.5,
              minWidth: 0,
              flexWrap: 'wrap',
            }}
          >
            {byline}
            <Box sx={{ flexGrow: 1 }} />
            <AttachmentCount attachments={thread.attachments} />
            {replyChip}
            {voteButton}
          </Box>
        </>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
            {title}
            <CategoryChip category={thread.category} />
            {statusChip}
          </Box>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mt: 0.75,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {thread.body}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              mt: 1.25,
              flexWrap: 'wrap',
            }}
          >
            {byline}
            <Box sx={{ flexGrow: 1 }} />
            <AttachmentCount attachments={thread.attachments} />
            {replyChip}
            {voteButton}
          </Box>
        </>
      )}
    </Paper>
  )
}

/** Column widths for the desktop table; the title takes whatever is left. */
const COLUMN_WIDTH = {
  type: 88,
  status: 104,
  author: 140,
  posted: 96,
  replies: 76,
  votes: 84,
} as const

/** Uppercase column header above every table view. */
const HEAD_CELL = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'text.secondary',
  whiteSpace: 'nowrap',
  py: 1,
} as const

/**
 * The byline gives way first: eight columns do not fit a laptop, and the author
 * and date are one click away inside the post.
 */
const SECONDARY_COLUMN = { display: { md: 'none', lg: 'table-cell' } } as const

/**
 * List view on a desktop: one fact per column, so rows line up and the board
 * scans like a table instead of a stack of small cards.
 */
function ThreadTable({
  threads,
  selectedId,
  likePending,
  onOpen,
  onToggleLike,
}: {
  threads: FeedbackThread[]
  selectedId: string | null
  likePending: string | null
  onOpen: (thread: FeedbackThread) => void
  onToggleLike: (thread: FeedbackThread) => void
}) {
  return (
    // `clip` (not `hidden`) rounds the corners off without turning the wrapper
    // into a scroll container, which would break the sticky header.
    <Paper variant="outlined" sx={{ overflow: 'clip' }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell sx={HEAD_CELL}>Title</TableCell>
            <TableCell sx={HEAD_CELL}>Content</TableCell>
            <TableCell sx={{ ...HEAD_CELL, width: COLUMN_WIDTH.type }}>Type</TableCell>
            <TableCell sx={{ ...HEAD_CELL, width: COLUMN_WIDTH.status }}>Status</TableCell>
            <TableCell sx={{ ...HEAD_CELL, ...SECONDARY_COLUMN, width: COLUMN_WIDTH.author }}>
              Posted by
            </TableCell>
            <TableCell sx={{ ...HEAD_CELL, ...SECONDARY_COLUMN, width: COLUMN_WIDTH.posted }}>
              Posted
            </TableCell>
            <TableCell align="right" sx={{ ...HEAD_CELL, width: COLUMN_WIDTH.replies }}>
              Replies
            </TableCell>
            <TableCell align="right" sx={{ ...HEAD_CELL, width: COLUMN_WIDTH.votes }}>
              Votes
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {threads.map((thread) => {
            const active = thread.id === selectedId
            const replies = `${thread.reply_count} ${thread.reply_count === 1 ? 'reply' : 'replies'}`
            return (
              <TableRow
                key={thread.id}
                hover
                tabIndex={0}
                aria-current={active || undefined}
                aria-label={`${categoryMeta(thread.category).label} feedback, ${thread.status}: ${thread.title}`}
                onClick={() => onOpen(thread)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpen(thread)
                  }
                }}
                sx={{
                  cursor: 'pointer',
                  // The accent rail is laid out on every row, so selecting one
                  // never shifts the text inside it.
                  '& .MuiTableCell-root:first-of-type': {
                    borderLeft: '3px solid',
                    borderLeftColor: active ? 'primary.main' : 'transparent',
                  },
                  bgcolor: active ? alpha('#d97757', 0.05) : undefined,
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: -2,
                  },
                }}
              >
                <TableCell sx={{ maxWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ fontWeight: 600, minWidth: 0 }}
                      title={thread.title}
                    >
                      {thread.title}
                    </Typography>
                    <AttachmentCount attachments={thread.attachments} />
                  </Box>
                </TableCell>
                <TableCell sx={{ maxWidth: 0 }}>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    noWrap
                    title={thread.body}
                  >
                    {thread.body}
                  </Typography>
                </TableCell>
                <TableCell>
                  <CategoryChip category={thread.category} />
                </TableCell>
                <TableCell>
                  <StatusChip status={thread.status} />
                </TableCell>
                <TableCell sx={SECONDARY_COLUMN}>
                  <Typography variant="body2" color="text.secondary" noWrap title={thread.author_name}>
                    {thread.author_name || 'Anonymous'}
                  </Typography>
                </TableCell>
                <TableCell sx={SECONDARY_COLUMN}>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {relativeTime(thread.created_at)}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" color="text.secondary" aria-label={replies}>
                    {thread.reply_count}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <VoteButton
                    thread={thread}
                    pending={likePending === thread.id}
                    dense
                    onToggle={() => onToggleLike(thread)}
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Paper>
  )
}

/** Read-only summary of a thread used by the create/edit dialog. */
function ThreadComposerDialog({
  open,
  editing,
  nickname,
  onClose,
  onSaveName,
  onSaved,
  onNotice,
}: {
  open: boolean
  /** The thread being edited, or null when composing a new one. */
  editing: FeedbackThread | null
  /** The name new posts are published under; the form can change it. */
  nickname: string
  onClose: () => void
  /** Stores a new display name for this machine. */
  onSaveName: (name: string) => Promise<void>
  onSaved: (thread: FeedbackThread) => void
  onNotice: (notice: Notice) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([])
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  // Re-seed the form whenever the dialog opens for a different target.
  useEffect(() => {
    if (!open) return
    setTitle(editing?.title ?? '')
    setBody(editing?.body ?? '')
    setCategory(editing?.category ?? 'bug')
    setAttachments(editing?.attachments ?? [])
    setName(nickname)
  }, [open, editing, nickname])

  const submit = async () => {
    if (!title.trim() || !body.trim()) {
      onNotice({ severity: 'error', message: 'Add a title and a description first.' })
      return
    }
    // The name is part of this machine's identity, not of the post, so an edit
    // never rewrites the byline of something already published.
    const authorName = name.trim()
    if (!editing && !authorName) {
      onNotice({ severity: 'error', message: 'Add the name to publish under.' })
      return
    }
    setSaving(true)
    try {
      if (!editing && authorName !== nickname) await onSaveName(authorName)
      const thread = editing
        ? await api.updateFeedbackThread(editing.id, {
            title: title.trim(),
            body: body.trim(),
            category,
          })
        : await api.createFeedbackThread({
            title: title.trim(),
            body: body.trim(),
            category,
            attachments,
          })
      onSaved(thread)
    } catch (error) {
      onNotice({ severity: 'error', message: errorText(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          pr: 1,
        }}
      >
        <Box component="span">{editing ? 'Edit feedback' : 'New feedback'}</Box>
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={saving}
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {!editing && (
            <TextField
              label="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 40 } }}
              fullWidth
              required
              helperText="Shown on your post. Remembered on this machine for next time."
            />
          )}
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            fullWidth
            autoFocus
          />
          <FormControl fullWidth>
            <InputLabel id="feedback-category-label">Category</InputLabel>
            <Select
              labelId="feedback-category-label"
              label="Category"
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
            >
              {CATEGORY_META.map((entry) => (
                <MenuItem key={entry.value} value={entry.value}>
                  {entry.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Description"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 8000 } }}
            multiline
            minRows={5}
            fullWidth
            helperText="What happened, what you expected, and any steps to reproduce it."
          />
          {!editing && (
            <AttachmentField
              attachments={attachments}
              onChange={setAttachments}
              onNotice={onNotice}
              disabled={saving}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2, gap: 1 }}>
        <Button onClick={onClose} disabled={saving} color="inherit" sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
          sx={{ minHeight: 48, minWidth: { xs: '100%', sm: 120 } }}
        >
          {editing ? 'Save' : 'Post'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Thread detail: body, replies, reply box and the author-only actions. */
function ThreadDetailView({
  detail,
  loading,
  error,
  onRetry,
  onEdit,
  onDelete,
  onDeleteReply,
  onReply,
  onToggleLike,
  onToggleStatus,
  onNotice,
}: {
  detail: FeedbackThreadDetail | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onEdit: (thread: FeedbackThread) => void
  onDelete: (thread: FeedbackThread) => void
  onDeleteReply: (reply: FeedbackReply) => void
  onReply: (body: string, attachments: FeedbackAttachment[]) => Promise<boolean>
  onToggleLike: () => void
  onToggleStatus: (thread: FeedbackThread) => void
  onNotice: (notice: Notice) => void
}) {
  // Whether the reply window is open. The draft itself lives inside
  // ReplyDialog, so a thread switch needs no cleanup here.
  const [replyOpen, setReplyOpen] = useState(false)

  // A thread switch closes any reply window left open on the previous post.
  useEffect(() => {
    setReplyOpen(false)
  }, [detail?.thread.id])

  if (loading && !detail) {
    return (
      <Box aria-busy="true" sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, p: 1 }}>
        <Skeleton variant="rounded" height={28} width="60%" />
        <Skeleton variant="rounded" height={16} width="92%" />
        <Skeleton variant="rounded" height={16} width="78%" />
      </Box>
    )
  }

  if (error && !detail) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry} startIcon={<RefreshIcon />}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    )
  }

  if (!detail) return null

  const { thread, replies } = detail
  const meta = categoryMeta(thread.category)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* The post and its replies scroll on their own…
          On the wide desktop panel the thread is centered in a readable
          column (~860px): full-bleed 1400px lines of serif body text would be
          as hard to read as the cramped old popup was. */}
      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
        <Box sx={{ maxWidth: 860, mx: 'auto' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h5" sx={{ flexGrow: 1, minWidth: 0, lineHeight: 1.3 }}>
              {thread.title}
            </Typography>
            <Chip label={meta.label} color={meta.color} size="small" variant="outlined" />
            {thread.status === 'resolved' && (
              <Chip label="Resolved" size="small" color="success" icon={<CheckCircleOutlinedIcon />} />
            )}
          </Box>
          <AuthorLine
            name={thread.author_name}
            version={thread.app_version}
            at={thread.created_at}
          />
          <Typography variant="body1" sx={{ mt: 1.5, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
            {thread.body}
          </Typography>
          <AttachmentList attachments={thread.attachments} large />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, flexWrap: 'wrap' }}>
            {/* Icon-only vote: the label was pure repetition of the thumb
                icon, so the count moves into the tooltip and aria-label. */}
            <Tooltip
              title={`Same problem — ${thread.like_count} ${thread.like_count === 1 ? 'vote' : 'votes'}`}
            >
              <Button
                size="small"
                variant={thread.liked_by_me ? 'contained' : 'outlined'}
                color={thread.liked_by_me ? 'primary' : 'inherit'}
                aria-pressed={thread.liked_by_me}
                aria-label={`Same problem — ${thread.like_count} ${thread.like_count === 1 ? 'vote' : 'votes'}`}
                onClick={onToggleLike}
                sx={{ minHeight: 36, minWidth: 36, p: 0.75 }}
              >
                {thread.liked_by_me ? <ThumbUpIcon /> : <ThumbUpOutlinedIcon />}
              </Button>
            </Tooltip>
            {/* The writing surface lives in its own window now, so the thread
                itself keeps every pixel for reading. */}
            <Button
              size="small"
              variant="contained"
              startIcon={<SendIcon />}
              onClick={() => setReplyOpen(true)}
              sx={{ minHeight: 36 }}
            >
              Reply
            </Button>
            {thread.mine && (
              <>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={thread.status === 'resolved' ? <ReplayIcon /> : <CheckCircleOutlinedIcon />}
                  onClick={() => onToggleStatus(thread)}
                  sx={{ minHeight: 48 }}
                >
                  {thread.status === 'resolved' ? 'Reopen' : 'Mark resolved'}
                </Button>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<EditOutlinedIcon />}
                  onClick={() => onEdit(thread)}
                  sx={{ minHeight: 48 }}
                >
                  Edit
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={() => onDelete(thread)}
                  sx={{ minHeight: 48 }}
                >
                  Delete
                </Button>
              </>
            )}
          </Box>
          {error && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              {error}
            </Alert>
          )}
        </Box>

        <Divider sx={{ my: 2.5 }} />

        <Box sx={{ pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
            {replies.length === 0
              ? 'No replies yet'
              : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
          </Typography>
          <Stack spacing={1.5}>
            {replies.map((reply) => (
              <Paper
                key={reply.id}
                variant="outlined"
                sx={{
                  p: { xs: 1.5, sm: 2 },
                  bgcolor: '#fcfbf8',
                  borderLeft: '3px solid',
                  borderColor: 'primary.light',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <AuthorLine
                      name={reply.author_name}
                      version={reply.app_version}
                      at={reply.created_at}
                    />
                  </Box>
                  {/* Reply sits left of the destructive Delete icon with a
                      wide gap so a stray tap cannot hit Delete. */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: -0.5 }}>
                    <Button
                      size="small"
                      color="primary"
                      startIcon={<SendIcon />}
                      onClick={() => setReplyOpen(true)}
                      sx={{ minHeight: 44 }}
                    >
                      Reply
                    </Button>
                    {reply.mine && (
                      <Tooltip title="Delete reply">
                        <IconButton
                          aria-label="Delete reply"
                          onClick={() => onDeleteReply(reply)}
                          size="small"
                          sx={{ minWidth: 44, minHeight: 44 }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </Box>
                <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mt: 0.5, lineHeight: 1.65 }}>
                  {reply.body}
                </Typography>
                <AttachmentList attachments={reply.attachments} large />
              </Paper>
            ))}
          </Stack>
        </Box>
        </Box>
      </Box>

      <ReplyDialog
        key={thread.id}
        open={replyOpen}
        onClose={() => setReplyOpen(false)}
        onSubmit={onReply}
        onNotice={onNotice}
      />
    </Box>
  )
}

/** Compose a reply in its own window.
 *
 * The thread used to keep a reply box pinned to its bottom edge, which cost
 * the reading area a permanent slice of the popup. Writing now happens in a
 * focused dialog instead, opened from the Reply buttons on the post and on
 * each reply, so the thread view is nothing but content. */
function ReplyDialog({
  open,
  onClose,
  onSubmit,
  onNotice,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (body: string, attachments: FeedbackAttachment[]) => Promise<boolean>
  onNotice: (notice: Notice) => void
}) {
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([])
  const [sending, setSending] = useState(false)

  // Every opening starts a fresh draft.
  useEffect(() => {
    if (!open) return
    setBody('')
    setAttachments([])
  }, [open])

  const submit = async () => {
    if (!body.trim()) return
    setSending(true)
    const ok = await onSubmit(body.trim(), attachments)
    setSending(false)
    if (ok) onClose()
  }

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          pr: 1,
        }}
      >
        <Box component="span">Write a reply</Box>
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={sending}
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <TextField
          label="Your reply"
          placeholder="Add details, agree, or answer the question"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          slotProps={{ htmlInput: { maxLength: 8000 } }}
          multiline
          minRows={5}
          maxRows={12}
          fullWidth
          autoFocus
        />
        <Box sx={{ mt: 2 }}>
          <AttachmentField
            attachments={attachments}
            onChange={setAttachments}
            onNotice={onNotice}
            disabled={sending}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={sending} sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={sending || !body.trim()}
          startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
          sx={{ minHeight: 48, minWidth: 140 }}
        >
          Reply
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function FeedbackPage() {
  const theme = useTheme()
  // A desktop shows an open post in a large centred window; a phone gets the
  // same window full-screen.
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))

  const [profile, setProfile] = useState<FeedbackProfile | null>(null)

  const [threads, setThreads] = useState<FeedbackThread[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [category, setCategory] = useState<FeedbackCategory | null>(null)
  const [status, setStatus] = useState<FeedbackStatus | null>(null)
  const [sort, setSort] = useState<FeedbackSort>('recent')
  const [query, setQuery] = useState('')
  // List first: it fits far more posts on screen, and the cards are one tap away.
  const [view, setView] = useState<'list' | 'card'>('list')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<FeedbackThreadDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const [composerOpen, setComposerOpen] = useState(false)
  const [editing, setEditing] = useState<FeedbackThread | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'thread'; thread: FeedbackThread } | { kind: 'reply'; reply: FeedbackReply } | null
  >(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [likePending, setLikePending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const loadThreads = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setListLoading(true)
    try {
      const response = await api.feedbackThreads({ category, status, sort })
      setThreads(response.threads)
      setListError(null)
    } catch (error) {
      setListError(errorText(error))
    } finally {
      setListLoading(false)
    }
  }, [category, status, sort])

  const loadDetail = useCallback(async (threadId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) setDetailLoading(true)
    try {
      const response = await api.feedbackThread(threadId)
      setDetail(response)
      setDetailError(null)
    } catch (error) {
      setDetailError(errorText(error))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // First load: this machine's identity (the name is part of the feedback form)
  // + the board.
  useEffect(() => {
    api
      .feedbackProfile()
      .then(setProfile)
      .catch(() => setProfile(null))
  }, [])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
    else setDetail(null)
  }, [selectedId, loadDetail])

  // Keep a visible board fresh without making a hidden tab poll the network.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadThreads({ silent: true })
      if (selectedId) void loadDetail(selectedId, { silent: true })
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadThreads, loadDetail, selectedId])

  // Opening a post always opens its own window, so the list keeps its width.
  const openThread = (thread: FeedbackThread) => {
    // Switching posts drops the previous post's content at once, so the
    // loading skeletons — not the stale thread — fill the window while the
    // new detail is being fetched.
    if (thread.id !== selectedId) setDetail(null)
    setSelectedId(thread.id)
    setDetailOpen(true)
  }

  const refreshAfterChange = async (threadId?: string | null) => {
    await loadThreads({ silent: true })
    if (threadId) await loadDetail(threadId, { silent: true })
  }

  /** Stores the name typed into the feedback form so later posts keep it. */
  const saveName = async (name: string) => {
    const saved = await api.saveFeedbackProfile(name)
    setProfile(saved)
  }

  const toggleLike = async (thread: FeedbackThread) => {
    setLikePending(thread.id)
    try {
      const result = await api.toggleFeedbackLike(thread.id)
      const patch = (item: FeedbackThread): FeedbackThread =>
        item.id === thread.id
          ? { ...item, liked_by_me: result.liked, like_count: result.like_count }
          : item
      setThreads((current) => current.map(patch))
      setDetail((current) =>
        current ? { ...current, thread: patch(current.thread) } : current,
      )
    } catch (error) {
      setNotice({ severity: 'error', message: errorText(error) })
    } finally {
      setLikePending(null)
    }
  }

  const toggleStatus = async (thread: FeedbackThread) => {
    try {
      const updated = await api.updateFeedbackThread(thread.id, {
        status: thread.status === 'resolved' ? 'open' : 'resolved',
      })
      setDetail((current) => (current ? { ...current, thread: updated } : current))
      await loadThreads({ silent: true })
    } catch (error) {
      setNotice({ severity: 'error', message: errorText(error) })
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleteBusy(true)
    try {
      if (pendingDelete.kind === 'thread') {
        await api.deleteFeedbackThread(pendingDelete.thread.id)
        setThreads((current) => current.filter((item) => item.id !== pendingDelete.thread.id))
        if (selectedId === pendingDelete.thread.id) {
          setSelectedId(null)
          setDetail(null)
          setDetailOpen(false)
        }
        setNotice({ severity: 'success', message: 'Feedback deleted.' })
        await loadThreads({ silent: true })
      } else {
        await api.deleteFeedbackReply(pendingDelete.reply.id)
        setDetail((current) =>
          current
            ? {
                ...current,
                replies: current.replies.filter((item) => item.id !== pendingDelete.reply.id),
              }
            : current,
        )
        setNotice({ severity: 'success', message: 'Reply deleted.' })
        await refreshAfterChange(selectedId)
      }
      setPendingDelete(null)
    } catch (error) {
      setNotice({ severity: 'error', message: errorText(error) })
    } finally {
      setDeleteBusy(false)
    }
  }

  const submitReply = async (body: string, attachments: FeedbackAttachment[]) => {
    if (!selectedId) return false
    try {
      await api.createFeedbackReply(selectedId, { body, attachments })
      await refreshAfterChange(selectedId)
      return true
    } catch (error) {
      setNotice({ severity: 'error', message: errorText(error) })
      return false
    }
  }

  // Search narrows the page already in memory; it never costs another request.
  const visibleThreads = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return threads
    return threads.filter((thread) =>
      [thread.title, thread.body, thread.author_name].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    )
  }, [threads, query])

  /** True when a search word or a filter is hiding part of the board. */
  const filtered = Boolean(query.trim() || category || status)

  const threadCountLabel = useMemo(() => {
    if (listLoading && threads.length === 0) return 'Loading…'
    if (visibleThreads.length !== threads.length) {
      return `${visibleThreads.length} of ${threads.length} ${
        threads.length === 1 ? 'post' : 'posts'
      }`
    }
    return `${threads.length} ${threads.length === 1 ? 'post' : 'posts'}`
  }, [listLoading, threads.length, visibleThreads.length])

  // Prev/next navigation inside the discussion window steps through the board
  // list the user was browsing, honouring the active search and filters.
  const selectedIndex = visibleThreads.findIndex((thread) => thread.id === selectedId)
  const navStep = (delta: number) => {
    const next = selectedIndex + delta
    if (next >= 0 && next < visibleThreads.length) openThread(visibleThreads[next])
  }

  const detailView = (
    <ThreadDetailView
      detail={detail}
      loading={detailLoading}
      error={detailError}
      onRetry={() => selectedId && void loadDetail(selectedId)}
      onEdit={(thread) => {
        setEditing(thread)
        setComposerOpen(true)
      }}
      onDelete={(thread) => setPendingDelete({ kind: 'thread', thread })}
      onDeleteReply={(reply) => setPendingDelete({ kind: 'reply', reply })}
      onReply={submitReply}
      onToggleLike={() => detail && void toggleLike(detail.thread)}
      onToggleStatus={(thread) => void toggleStatus(thread)}
      onNotice={setNotice}
    />
  )

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        bgcolor: 'background.default',
        // On a phone the board scrolls as one page, so the toolbar gives its
        // height back to the list; from md up the band is fixed and each column
        // scrolls on its own.
        overflowY: { xs: 'auto', md: 'hidden' },
      }}
    >
      {/* One band owns the whole toolbar, so the filters and the composer entry
          point stay in reach while the board below scrolls. */}
      <Box
        sx={{
          flexShrink: 0,
          bgcolor: 'background.paper',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box
          sx={{
            maxWidth: PAGE_MAX_WIDTH,
            mx: 'auto',
            px: PAGE_GUTTER,
            pt: { xs: 1.5, sm: 2 },
            pb: 1.5,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: { xs: 'stretch', sm: 'flex-start' },
              gap: 1.5,
              mb: 1.5,
            }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              {/* The "Feedback" heading lives in the dialog's title bar. */}
              <Typography variant="body2" color="text.secondary">
                Report a problem, suggest an improvement or ask a question. Everything here
                is visible to every user of this app.
              </Typography>
            </Box>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                flexWrap: 'wrap',
                justifyContent: { xs: 'flex-start', sm: 'flex-end' },
              }}
            >
              {/* One control that flips between the two layouts; the icon is
                  the view it switches to, so the label is never ambiguous. */}
              <Tooltip title={view === 'list' ? 'Switch to card view' : 'Switch to list view'}>
                <IconButton
                  aria-label={view === 'list' ? 'Switch to card view' : 'Switch to list view'}
                  aria-pressed={view === 'card'}
                  onClick={() => setView(view === 'list' ? 'card' : 'list')}
                  sx={{ flexShrink: 0 }}
                >
                  {view === 'list' ? <GridViewIcon /> : <ViewListIcon />}
                </IconButton>
              </Tooltip>
              <Button
                size="small"
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => {
                  setEditing(null)
                  setComposerOpen(true)
                }}
                sx={{
                  // Compact beside the toolbar text on a mouse-driven desktop,
                  // but still a full touch target on a phone.
                  minHeight: { xs: 48, sm: 32 },
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                New feedback
              </Button>
            </Box>
          </Box>

          <Alert severity="info" icon={false} sx={{ mb: 1.5 }}>
            No sign-in is required, so please do not paste confidential data (customer
            names, credentials, proprietary process details) into a post or an attachment.
          </Alert>

          <Box
            sx={{
              display: 'flex',
              gap: 1,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <TextField
              size="small"
              id="feedback-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search feedback"
              sx={{
                width: { xs: '100%', sm: 220 },
                '& .MuiOutlinedInput-root': { minHeight: 48 },
              }}
              slotProps={{
                htmlInput: { 'aria-label': 'Search feedback' },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Chip
              label="All"
              color={category === null ? 'primary' : 'default'}
              variant={category === null ? 'filled' : 'outlined'}
              onClick={() => setCategory(null)}
              sx={{ minHeight: 36 }}
            />
            {CATEGORY_META.map((entry) => (
              <Chip
                key={entry.value}
                label={entry.label}
                color={category === entry.value ? entry.color : 'default'}
                variant={category === entry.value ? 'filled' : 'outlined'}
                onClick={() => setCategory(category === entry.value ? null : entry.value)}
                sx={{ minHeight: 36 }}
              />
            ))}
            <Box sx={{ flexGrow: 1 }} />
            <Chip
              label={
                status === 'open'
                  ? 'Open only'
                  : status === 'resolved'
                    ? 'Resolved only'
                    : 'Any status'
              }
              variant="outlined"
              onClick={() =>
                setStatus(status === null ? 'open' : status === 'open' ? 'resolved' : null)
              }
              sx={{ minHeight: 36 }}
            />
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="feedback-sort-label">Sort</InputLabel>
              <Select
                labelId="feedback-sort-label"
                label="Sort"
                value={sort}
                onChange={(event) => setSort(event.target.value as FeedbackSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Refresh">
              <IconButton
                aria-label="Refresh feedback"
                onClick={() => {
                  void loadThreads()
                  if (selectedId) void loadDetail(selectedId)
                }}
                sx={{ minWidth: 48, minHeight: 48 }}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Box>

          {listError && (
            <Alert
              severity="error"
              sx={{ mt: 1.5 }}
              action={
                <Button color="inherit" size="small" onClick={() => void loadThreads()}>
                  Retry
                </Button>
              }
            >
              {listError}
            </Alert>
          )}
        </Box>
      </Box>

      {/* The board is only the collection: everything about a single post opens
          in its own window, so no post ever has to share the page width. */}
      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: PAGE_MAX_WIDTH,
          mx: 'auto',
          px: PAGE_GUTTER,
          pb: 2,
        }}
      >
        <Box
          sx={{
            minHeight: 0,
            height: isDesktop ? '100%' : 'auto',
            overflowY: isDesktop ? 'auto' : 'visible',
            pr: isDesktop ? 0.5 : 0,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {threadCountLabel}
          </Typography>

          {listLoading && threads.length === 0 ? (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <Skeleton variant="rounded" height={view === 'list' ? 44 : 112} />
              <Skeleton variant="rounded" height={view === 'list' ? 44 : 112} />
              <Skeleton variant="rounded" height={view === 'list' ? 44 : 112} />
            </Box>
          ) : visibleThreads.length === 0 && !listError ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
              <ForumOutlinedIcon sx={{ fontSize: 36, color: 'text.disabled' }} />
              <Typography variant="subtitle2" sx={{ mt: 1, fontWeight: 700 }}>
                {filtered ? 'No matching post' : 'Nothing here yet'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {filtered
                  ? 'Try another word, or clear the search and the filters.'
                  : 'Start the conversation: report a problem or suggest an idea.'}
              </Typography>
              {/* An empty screen must always offer the way out of it. */}
              <Button
                variant={filtered ? 'outlined' : 'contained'}
                color={filtered ? 'inherit' : 'primary'}
                startIcon={filtered ? undefined : <AddIcon />}
                onClick={() => {
                  if (filtered) {
                    setQuery('')
                    setCategory(null)
                    setStatus(null)
                  } else {
                    setEditing(null)
                    setComposerOpen(true)
                  }
                }}
                sx={{ mt: 2, minHeight: 48, minWidth: { xs: '100%', sm: 180 } }}
              >
                {filtered ? 'Clear search and filters' : 'New feedback'}
              </Button>
            </Paper>
          ) : view === 'list' && isDesktop ? (
            <ThreadTable
              threads={visibleThreads}
              selectedId={selectedId}
              likePending={likePending}
              onOpen={openThread}
              onToggleLike={(thread) => void toggleLike(thread)}
            />
          ) : (
            <Box
              sx={{
                display: 'grid',
                gap: view === 'list' ? 1 : 2,
                alignItems: 'start',
                pb: 1,
                // Cards tile into two columns on a desktop; a list stays in one.
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
              }}
            >
              {visibleThreads.map((thread) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  active={thread.id === selectedId}
                  compact={view === 'list'}
                  onOpen={() => openThread(thread)}
                  onToggleLike={() => void toggleLike(thread)}
                  likePending={likePending === thread.id}
                />
              ))}
            </Box>
          )}
        </Box>
      </Box>

      {/* One post, one window: a full-screen sheet on a phone and a near-full
          workspace panel on a desktop. The window is deliberately as large as
          the screen allows — the point of a discussion is the content, so the
          panel claims 92vh of height and the xl width band, leaving the board
          visible only as a thin frame. Corners match the reply window's 16px
          radius (the theme default); the phone sheet stays square because a
          full-screen sheet with rounded corners just shows background gaps. */}
      <Dialog
        open={detailOpen && (!!selectedId || detailLoading)}
        onClose={() => setDetailOpen(false)}
        fullScreen={!isDesktop}
        fullWidth
        maxWidth="xl"
        slotProps={{
          paper: {
            sx: {
              // A string, not a number: sx multiplies numeric borderRadius
              // values by theme.shape.borderRadius (12), which turned `16`
              // into a 192px blob. '16px' matches the reply window's corners.
              borderRadius: { xs: 0, md: '16px' },
              // The panel needs a definite height so the thread can scroll
              // inside it while the reply box stays put at the bottom.
              height: { xs: '100%', md: 'min(1150px, 92vh)' },
              maxWidth: { md: 'min(1400px, 96vw)' },
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            py: 1,
            pr: 1,
            borderBottom: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <Box component="span">Discussion</Box>
          {/* A normal flex child, so the bar's own `alignItems: center` is what
              centres it. Absolute positioning was the bug: with no positioned
              ancestor nearby the offsets resolved against the whole window. */}
          <IconButton
            aria-label="Close discussion"
            onClick={() => setDetailOpen(false)}
            size="small"
            sx={{ color: 'text.secondary' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        {/* Visible while the clicked post's content is being fetched — the
            bar sits under the title so the window itself reads as busy. */}
        {detailLoading && <LinearProgress sx={{ flexShrink: 0 }} />}
        <DialogContent
          sx={{
            px: { xs: 1.5, sm: 3 },
            pb: { xs: 1.5, sm: 2 },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Previous / next: move through the posts of the board the user was
              browsing, in its current order. 48px targets keep the taps easy
              on touch screens. */}
          <Box
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              pt: 0.5,
              pb: 1,
            }}
          >
            <Button
              size="small"
              startIcon={<ChevronLeftIcon />}
              onClick={() => navStep(-1)}
              disabled={selectedIndex <= 0}
              sx={{ minHeight: 48 }}
            >
              Previous
            </Button>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ minWidth: 64, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
            >
              {selectedIndex >= 0 ? `${selectedIndex + 1} / ${visibleThreads.length}` : '–'}
            </Typography>
            <Button
              size="small"
              endIcon={<ChevronRightIcon />}
              onClick={() => navStep(1)}
              disabled={selectedIndex < 0 || selectedIndex >= visibleThreads.length - 1}
              sx={{ minHeight: 48 }}
            >
              Next
            </Button>
          </Box>
          <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {detailView}
          </Box>
        </DialogContent>
      </Dialog>

      <ThreadComposerDialog
        open={composerOpen}
        editing={editing}
        nickname={profile?.nickname ?? ''}
        onClose={() => {
          setComposerOpen(false)
          setEditing(null)
        }}
        onSaveName={saveName}
        onSaved={async (thread) => {
          setComposerOpen(false)
          const created = !editing
          setEditing(null)
          setNotice({
            severity: 'success',
            message: created ? 'Feedback posted.' : 'Feedback updated.',
          })
          await loadThreads({ silent: true })
          setSelectedId(thread.id)
          if (created) setDetailOpen(true)
        }}
        onNotice={setNotice}
      />

      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {pendingDelete?.kind === 'reply' ? 'Delete reply?' : 'Delete feedback?'}
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {pendingDelete?.kind === 'reply'
              ? 'This reply will be removed for everyone. This cannot be undone.'
              : 'The post, its replies and its votes will be removed for everyone. This cannot be undone.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
          <Button
            onClick={() => setPendingDelete(null)}
            color="inherit"
            disabled={deleteBusy}
            sx={{ minHeight: 48 }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={confirmDelete}
            disabled={deleteBusy}
            startIcon={deleteBusy ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            sx={{ minHeight: 48 }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice?.severity ?? 'info'}
          variant="filled"
          onClose={() => setNotice(null)}
          sx={{ width: '100%' }}
        >
          {notice?.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default FeedbackPage
