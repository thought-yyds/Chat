<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSegmentStudioStore, type ItemStatus } from '@/stores/segmentStudio'

const store = useSegmentStudioStore()
const { batches, activeBatch } = storeToRefs(store)

const imageInputRef = useTemplateRef<HTMLInputElement>('imageInput')
const folderInputRef = useTemplateRef<HTMLInputElement>('folderInput')
const dragOver = ref(false)
const processing = ref(false)
const deleteConfirmBatchId = ref<string | null>(null)

function onDeleteModalKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') closeDeleteConfirm()
}

watch(deleteConfirmBatchId, (id) => {
  if (id) {
    window.addEventListener('keydown', onDeleteModalKeydown)
    document.body.style.overflow = 'hidden'
  } else {
    window.removeEventListener('keydown', onDeleteModalKeydown)
    document.body.style.overflow = ''
  }
})

const deleteConfirmLabel = computed(() => {
  const id = deleteConfirmBatchId.value
  if (!id) return ''
  return batches.value.find((b) => b.id === id)?.label ?? ''
})

const deleteConfirmMeta = computed(() => {
  const id = deleteConfirmBatchId.value
  if (!id) return ''
  const b = batches.value.find((x) => x.id === id)
  return b ? `${b.items.length} 张` : ''
})

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return IMAGE_RE.test(file.name)
}

function fileDedupeKey(file: File): string {
  return `${file.name}-${file.size}-${(file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''}`
}

function dedupeFiles(files: File[]): File[] {
  const out: File[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const key = fileDedupeKey(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** 严格校验：全部为图片才通过；文件夹内若混有非图片则整批拒绝 */
function validateStrictImages(files: File[]): { ok: true; images: File[] } | { ok: false; message: string } {
  if (files.length === 0) {
    return { ok: false, message: '没有检测到可上传的文件（文件夹可能为空）。' }
  }
  const nonImages = files.filter((f) => !isImageFile(f))
  if (nonImages.length > 0) {
    const samples = nonImages
      .slice(0, 3)
      .map((f) => f.name || '(无名称)')
      .join('、')
    const tail = nonImages.length > 3 ? ` 等共 ${nonImages.length} 个` : ''
    return {
      ok: false,
      message: `仅支持图片。检测到非图片文件：${samples}${tail}。请只选择图片，或只包含图片的文件夹。`,
    }
  }
  const images = dedupeFiles(files)
  if (images.length === 0) {
    return { ok: false, message: '没有有效的图片文件。' }
  }
  return { ok: true, images }
}

function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const acc: FileSystemEntry[] = []
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(acc)
            return
          }
          acc.push(...entries)
          readBatch()
        },
        reject,
      )
    }
    readBatch()
  })
}

function assignRelativePath(file: File, relativePath: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: relativePath,
      enumerable: true,
      configurable: true,
    })
  } catch {
    /* 部分环境不可写，仍返回原 File */
  }
  return file
}

async function collectFilesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const fe = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) => {
      fe.file(resolve, reject)
    })
    const rel = entry.fullPath.replace(/^\//, '')
    if (rel && rel !== file.name) assignRelativePath(file, rel)
    return [file]
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const entries = await readAllDirectoryEntries(reader)
    const nested: File[] = []
    for (const e of entries) nested.push(...(await collectFilesFromEntry(e)))
    return nested
  }
  return []
}

/** 拖入：尽量解析文件夹结构（Chrome / Edge）；否则回退到 dataTransfer.files */
async function collectAllDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = []
  const items = dt.items
  if (items?.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const wk = item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }
      const entry = typeof wk.webkitGetAsEntry === 'function' ? wk.webkitGetAsEntry() : null
      if (entry) {
        out.push(...(await collectFilesFromEntry(entry)))
        continue
      }
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  if (out.length === 0 && dt.files?.length) {
    out.push(...Array.from(dt.files))
  }
  return out
}

let uploadErrorTimer: ReturnType<typeof setTimeout> | null = null
const uploadError = ref<string | null>(null)

function showUploadError(message: string, durationMs = 6000) {
  if (uploadErrorTimer) {
    clearTimeout(uploadErrorTimer)
    uploadErrorTimer = null
  }
  uploadError.value = message
  uploadErrorTimer = setTimeout(() => {
    uploadError.value = null
    uploadErrorTimer = null
  }, durationMs)
}

function clearUploadError() {
  uploadError.value = null
  if (uploadErrorTimer) {
    clearTimeout(uploadErrorTimer)
    uploadErrorTimer = null
  }
}

interface StagedItem {
  id: string
  file: File
  previewUrl: string
}

function stagedUid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function revokeStagedItem(it: StagedItem) {
  URL.revokeObjectURL(it.previewUrl)
}

const stagedItems = ref<StagedItem[]>([])
const composerDocked = ref(false)

const stagedCount = computed(() => stagedItems.value.length)

function stagedCaption(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return rel || file.name
}

function removeStagedItem(id: string) {
  const idx = stagedItems.value.findIndex((s) => s.id === id)
  if (idx === -1) return
  const [it] = stagedItems.value.splice(idx, 1)
  if (it) revokeStagedItem(it)
}

/** 将一次选择/拖入的文件校验后加入待检测列表（不调用模型） */
function mergeIntoStageFromFiles(files: File[]) {
  if (files.length === 0) return
  const result = validateStrictImages(files)
  if (!result.ok) {
    showUploadError(result.message)
    return
  }
  clearUploadError()
  const existing = new Set(stagedItems.value.map((s) => fileDedupeKey(s.file)))
  for (const file of result.images) {
    const k = fileDedupeKey(file)
    if (existing.has(k)) continue
    existing.add(k)
    stagedItems.value.push({
      id: stagedUid(),
      file,
      previewUrl: URL.createObjectURL(file),
    })
  }
}

interface ProgressLogEntry {
  id: string
  tag: '处理中' | '完成' | '错误'
  text: string
  /** 流式展示到当前长度 */
  revealedText: string
}

const progressLog = ref<ProgressLogEntry[]>([])
/** 为 true 时在工作台中部偏上显示进度，不展示结果网格 */
const progressCentered = ref(false)
/** 与进度记录对应的批次 id，切换左侧历史时可隐藏不匹配的「处理记录」 */
const progressLogBatchId = ref<string | null>(null)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pushProgressStream(
  tag: ProgressLogEntry['tag'],
  text: string,
  options?: { charMs?: number; chunk?: number },
) {
  const charMs = options?.charMs ?? 12
  const chunk = options?.chunk ?? (text.length > 72 ? 3 : 2)
  const id = stagedUid()
  const entry: ProgressLogEntry = { id, tag, text, revealedText: '' }
  progressLog.value.push(entry)
  for (let n = chunk; n < text.length + chunk; n += chunk) {
    entry.revealedText = text.slice(0, Math.min(n, text.length))
    await sleep(charMs)
  }
  entry.revealedText = text
}

const API_SEGMENT = '/api/segment'

async function runSegmentForFile(file: File): Promise<Blob> {
  const body = new FormData()
  body.append('file', file, file.name)
  const res = await fetch(API_SEGMENT, { method: 'POST', body })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.blob()
}

async function processBatch(batchId: string) {
  const batch = batches.value.find((b) => b.id === batchId)
  if (!batch) return
  const total = batch.items.length
  progressLogBatchId.value = batchId
  progressLog.value = []
  progressCentered.value = true
  processing.value = true

  try {
    await pushProgressStream('处理中', '正在加载模型...')
    await sleep(280)

    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i]
      if (!batches.value.some((b) => b.id === batchId)) break
      await pushProgressStream('处理中', `正在处理图片 ${i + 1}/${total}: ${item.name}`)
      store.patchItem(batchId, item.id, { status: 'running', error: null })
      try {
        const blob = await runSegmentForFile(item.file)
        const url = URL.createObjectURL(blob)
        store.patchItem(batchId, item.id, { status: 'done', resultUrl: url })
      } catch (e) {
        const msg = e instanceof Error ? e.message : '请求失败'
        store.patchItem(batchId, item.id, { status: 'error', error: msg })
        await pushProgressStream('错误', `${item.name}: ${msg}`)
      }
    }
    await pushProgressStream('处理中', '分割完成，正在生成结果...')
    await sleep(320)
    await pushProgressStream('完成', `共处理 ${total} 张图片，点击下方结果查看`)
  } finally {
    processing.value = false
    progressCentered.value = false
  }
}

async function enqueueValidatedImages(images: File[]) {
  if (images.length === 0) return
  const batchId = store.addBatchFromFiles(images)
  await processBatch(batchId)
}

/** 仅在此提交后创建批次并调用分割接口；提交后输入区固定到底部（对话式布局） */
async function submitWeldInspection() {
  if (processing.value) return
  if (stagedItems.value.length === 0) {
    showUploadError('请先通过「选择图片」「选择文件夹」或拖入，添加待检测图片。')
    return
  }
  const snapshot = stagedItems.value.map((s) => s.file)
  const result = validateStrictImages(snapshot)
  if (!result.ok) {
    showUploadError(result.message)
    return
  }
  clearUploadError()
  for (const it of stagedItems.value) revokeStagedItem(it)
  stagedItems.value = []
  composerDocked.value = true
  await enqueueValidatedImages(result.images)
}

function onImagePicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = input.files
  if (files?.length) mergeIntoStageFromFiles(Array.from(files))
  input.value = ''
}

function onFolderPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = input.files
  if (files?.length) mergeIntoStageFromFiles(Array.from(files))
  input.value = ''
}

async function onDrop(ev: DragEvent) {
  ev.preventDefault()
  dragOver.value = false
  const dt = ev.dataTransfer
  if (!dt) return
  const files = await collectAllDroppedFiles(dt)
  mergeIntoStageFromFiles(files)
}

function onDragOver(ev: DragEvent) {
  const types = ev.dataTransfer?.types ?? []
  if (!types.includes('Files')) {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none'
    return
  }
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
  dragOver.value = true
}

function onDragLeaveCapture(ev: DragEvent) {
  const root = ev.currentTarget as HTMLElement | null
  const next = ev.relatedTarget as Node | null
  if (root && next && root.contains(next)) return
  dragOver.value = false
}

function openDeleteConfirm(batchId: string) {
  deleteConfirmBatchId.value = batchId
}

function closeDeleteConfirm() {
  deleteConfirmBatchId.value = null
}

function commitDeleteConfirm() {
  const id = deleteConfirmBatchId.value
  if (id) store.removeBatch(id)
  closeDeleteConfirm()
}

const emptyState = computed(
  () => !activeBatch.value || activeBatch.value.items.length === 0,
)

const submitDisabled = computed(() => processing.value || stagedCount.value === 0)

/** 检测结果列表：超过该数量则分页展示 */
const RESULT_LIST_PAGINATE_THRESHOLD = 10
const RESULT_LIST_PAGE_SIZE = 8

const resultListPage = ref(1)
const resultListJumpDraft = ref(1)

const resultListItems = computed(() => activeBatch.value?.items ?? [])
const resultListTotalCount = computed(() => resultListItems.value.length)

const resultListUsePagination = computed(
  () => resultListTotalCount.value > RESULT_LIST_PAGINATE_THRESHOLD,
)

const resultListTotalPages = computed(() => {
  const n = resultListTotalCount.value
  if (n <= RESULT_LIST_PAGINATE_THRESHOLD) return 1
  return Math.max(1, Math.ceil(n / RESULT_LIST_PAGE_SIZE))
})

const resultListVisibleItems = computed(() => {
  const items = resultListItems.value
  if (!resultListUsePagination.value) return items
  const start = (resultListPage.value - 1) * RESULT_LIST_PAGE_SIZE
  return items.slice(start, start + RESULT_LIST_PAGE_SIZE)
})

const resultListPageNumbers = computed(() =>
  Array.from({ length: resultListTotalPages.value }, (_, i) => i + 1),
)

function goResultPage(p: number) {
  const max = resultListTotalPages.value
  const n = Math.min(Math.max(1, Math.floor(Number(p))), max)
  if (!Number.isFinite(n)) return
  resultListPage.value = n
}

function goResultPrevPage() {
  goResultPage(resultListPage.value - 1)
}

function goResultNextPage() {
  goResultPage(resultListPage.value + 1)
}

function commitResultListJump() {
  const raw = resultListJumpDraft.value
  const p = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw)
  if (!Number.isFinite(p)) {
    resultListJumpDraft.value = resultListPage.value
    return
  }
  goResultPage(p)
  resultListJumpDraft.value = resultListPage.value
}

watch(resultListPage, (p) => {
  resultListJumpDraft.value = p
})

watch(
  () => activeBatch.value?.id,
  () => {
    resultListPage.value = 1
    resultListJumpDraft.value = 1
  },
)

watch([resultListTotalPages, resultListTotalCount], () => {
  const max = resultListTotalPages.value
  if (resultListPage.value > max) resultListPage.value = max
  if (resultListPage.value < 1) resultListPage.value = 1
  resultListJumpDraft.value = resultListPage.value
})

/** 结果列表与详情抽屉：当前打开的条目 id */
const detailItemId = ref<string | null>(null)
const detailZoomOriginal = ref(1)
const detailZoomResult = ref(1)

const detailItem = computed(() => {
  const batch = activeBatch.value
  const id = detailItemId.value
  if (!batch || !id) return null
  return batch.items.find((i) => i.id === id) ?? null
})

function statusLabel(status: ItemStatus): string {
  switch (status) {
    case 'pending':
      return '等待'
    case 'running':
      return '处理中'
    case 'done':
      return '成功'
    case 'error':
      return '失败'
    default:
      return status
  }
}

function openDetail(itemId: string) {
  detailItemId.value = itemId
  detailZoomOriginal.value = 1
  detailZoomResult.value = 1
}

function closeDetail() {
  detailItemId.value = null
}

function clampZoom(z: number): number {
  return Math.min(4, Math.max(0.25, z))
}

function bumpOriginalZoom(delta: number) {
  detailZoomOriginal.value = clampZoom(detailZoomOriginal.value + delta)
}

function bumpResultZoom(delta: number) {
  detailZoomResult.value = clampZoom(detailZoomResult.value + delta)
}

function onDetailKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') closeDetail()
}

watch(detailItemId, (id) => {
  if (id) {
    window.addEventListener('keydown', onDetailKeydown)
    document.body.style.overflow = 'hidden'
  } else {
    window.removeEventListener('keydown', onDetailKeydown)
    document.body.style.overflow = ''
  }
})

watch(
  () => activeBatch.value?.id,
  () => {
    if (detailItemId.value && !detailItem.value) closeDetail()
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDeleteModalKeydown)
  window.removeEventListener('keydown', onDetailKeydown)
  document.body.style.overflow = ''
  closeDetail()
  if (uploadErrorTimer) {
    clearTimeout(uploadErrorTimer)
    uploadErrorTimer = null
  }
  for (const it of stagedItems.value) revokeStagedItem(it)
  stagedItems.value = []
  for (const b of batches.value) {
    for (const it of b.items) {
      URL.revokeObjectURL(it.originalUrl)
      if (it.resultUrl) URL.revokeObjectURL(it.resultUrl)
    }
  }
})
</script>

<template>
  <div class="studio">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-title">焊缝缺陷智能检测大模型</span>
        <span class="brand-sub">上传记录</span>
      </div>
      <div class="history">
        <div
          v-for="b in batches"
          :key="b.id"
          class="history-item"
          :class="{ active: b.id === store.activeBatchId }"
        >
          <button type="button" class="history-select" @click="store.selectBatch(b.id)">
            <span class="history-label">{{ b.label }}</span>
            <span class="history-meta">{{ b.items.length }} 张</span>
          </button>
          <button
            type="button"
            class="history-delete"
            title="删除此条记录"
            aria-label="删除此条上传记录"
            @click.stop="openDeleteConfirm(b.id)"
          >
            删除
          </button>
        </div>
        <p v-if="batches.length === 0" class="history-empty">暂无上传记录</p>
      </div>
    </aside>

    <main
      class="main"
      @dragover.capture.prevent="onDragOver"
      @dragleave.capture="onDragLeaveCapture"
      @drop.capture.prevent="onDrop"
    >
      <header class="toolbar">
        <h1 class="page-title">工作台</h1>
        <p v-if="stagedCount > 0 && !processing" class="toolbar-staged">待检测：{{ stagedCount }} 张</p>
        <p v-if="processing" class="toolbar-status">正在处理当前批次…</p>
      </header>

      <div class="main-body" :class="{ 'main-body--docked': composerDocked }">
        <template v-if="composerDocked">
          <section class="scroll scroll--dock">
            <div
              v-if="progressCentered && progressLog.length"
              class="progress-center-wrap"
            >
              <div class="progress-center-card" role="status" aria-live="polite" aria-atomic="false">
                <p class="progress-center-title">焊缝检测</p>
                <ul class="progress-lines">
                  <li
                    v-for="ln in progressLog"
                    :key="ln.id"
                    class="progress-line"
                    :data-tag="ln.tag"
                  >
                    <span class="progress-bracket">[{{ ln.tag }}]</span>
                    <span class="progress-text">
                      {{ ln.revealedText }}<span v-if="ln.revealedText.length < ln.text.length" class="progress-cursor" aria-hidden="true">▍</span>
                    </span>
                  </li>
                </ul>
              </div>
            </div>

            <template v-if="!progressCentered">
              <div
                v-if="progressLog.length && !emptyState && activeBatch?.id === progressLogBatchId"
                class="progress-inline"
                aria-label="处理记录"
              >
                <p class="progress-inline-title">处理记录</p>
                <ul class="progress-lines progress-lines--compact">
                  <li
                    v-for="ln in progressLog"
                    :key="ln.id"
                    class="progress-line"
                    :data-tag="ln.tag"
                  >
                    <span class="progress-bracket">[{{ ln.tag }}]</span>
                    <span class="progress-text">
                      {{ ln.revealedText }}<span v-if="ln.revealedText.length < ln.text.length" class="progress-cursor" aria-hidden="true">▍</span>
                    </span>
                  </li>
                </ul>
              </div>

              <div v-if="emptyState" class="placeholder">
                <p>在下方输入区选择或拖入<strong>图片</strong>加入待检测列表。</p>
                <p class="hint">可多次添加；点击「提交焊缝检测」开始检测。</p>
              </div>

              <div v-else class="result-list-wrap">
                <table class="result-table" aria-label="检测结果列表">
                  <thead>
                    <tr>
                      <th scope="col">文件名</th>
                      <th scope="col">状态</th>
                      <th scope="col" class="result-table-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in resultListVisibleItems" :key="item.id">
                      <td class="result-table-name" :title="item.relativePath">{{ item.relativePath }}</td>
                      <td>
                        <span class="badge" :data-status="item.status">{{ statusLabel(item.status) }}</span>
                      </td>
                      <td class="result-table-actions">
                        <button type="button" class="btn btn-sm" @click="openDetail(item.id)">查看详情</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <nav
                  v-if="resultListUsePagination"
                  class="result-pagination"
                  aria-label="结果列表分页"
                >
                  <div class="result-pagination-info">
                    第 <strong>{{ resultListPage }}</strong> / {{ resultListTotalPages }} 页，每页
                    {{ RESULT_LIST_PAGE_SIZE }} 张，共 {{ resultListTotalCount }} 张
                  </div>
                  <div class="result-pagination-row">
                    <button
                      type="button"
                      class="btn btn-sm"
                      :disabled="resultListPage <= 1"
                      @click="goResultPrevPage"
                    >
                      上一页
                    </button>
                    <div
                      v-if="resultListTotalPages <= 16"
                      class="result-page-nums"
                      role="navigation"
                      aria-label="页码"
                    >
                      <button
                        v-for="p in resultListPageNumbers"
                        :key="p"
                        type="button"
                        class="btn btn-page"
                        :class="{ 'btn-page--active': p === resultListPage }"
                        :aria-current="p === resultListPage ? 'page' : undefined"
                        @click="goResultPage(p)"
                      >
                        {{ p }}
                      </button>
                    </div>
                    <button
                      type="button"
                      class="btn btn-sm"
                      :disabled="resultListPage >= resultListTotalPages"
                      @click="goResultNextPage"
                    >
                      下一页
                    </button>
                  </div>
                  <div class="result-pagination-jump">
                    <label class="result-pagination-jump-label" for="result-list-jump-dock">跳转到</label>
                    <input
                      id="result-list-jump-dock"
                      v-model.number="resultListJumpDraft"
                      class="result-pagination-jump-input"
                      type="number"
                      min="1"
                      :max="resultListTotalPages"
                      @keydown.enter.prevent="commitResultListJump"
                    />
                    <button type="button" class="btn btn-sm" @click="commitResultListJump">确定</button>
                  </div>
                </nav>
              </div>
            </template>
          </section>

          <div class="composer-slot composer-slot--docked">
            <div class="composer-stack">
              <p v-if="uploadError" class="composer-error" role="status">{{ uploadError }}</p>
              <div
                class="composer-panel"
                :class="{ 'drag-over': dragOver, 'has-staged': stagedCount > 0 }"
                role="group"
                aria-label="待检测：选择或拖入图片，提交后开始检测"
              >
                <div v-if="stagedCount > 0" class="staged-strip">
                  <div v-for="item in stagedItems" :key="item.id" class="staged-chip">
                    <div class="staged-chip-img">
                      <img :src="item.previewUrl" :alt="item.file.name" />
                    </div>
                    <span class="staged-chip-cap" :title="stagedCaption(item.file)">{{ stagedCaption(item.file) }}</span>
                    <button
                      type="button"
                      class="staged-chip-remove"
                      title="从待检测列表移除"
                      aria-label="移除"
                      @click.stop="removeStagedItem(item.id)"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div class="composer-pill-row">
                  <div class="pill-readonly" aria-readonly="true" tabindex="-1">
                    <template v-if="dragOver">
                      <span class="pill-placeholder pill-drag-title">松开以加入待检测列表</span>
                      <span class="pill-note">支持<strong>图片</strong>或<strong>文件夹</strong>（须全部为图片）</span>
                    </template>
                    <template v-else>
                      <span class="pill-placeholder">
                        {{ stagedCount > 0 ? `待检测 ${stagedCount} 张` : '添加待检测图片' }}
                      </span>
                      <span class="pill-note">可继续添加后再次提交检测</span>
                    </template>
                  </div>
                  <div class="pill-actions">
                    <button type="button" class="btn" @click="imageInputRef?.click()">选择图片</button>
                    <button type="button" class="btn" @click="folderInputRef?.click()">选择文件夹</button>
                    <button
                      type="button"
                      class="btn btn-submit"
                      :disabled="submitDisabled"
                      @click="void submitWeldInspection()"
                    >
                      提交焊缝检测
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <input
              ref="imageInput"
              class="hidden-input"
              type="file"
              accept="image/*"
              multiple
              @change="onImagePicked"
            />
            <input
              ref="folderInput"
              class="hidden-input"
              type="file"
              multiple
              webkitdirectory
              @change="onFolderPicked"
            />
          </div>
        </template>

        <template v-else>
          <div class="main-center-column">
            <section class="scroll scroll--floating">
              <div v-if="emptyState" class="placeholder">
                <template v-if="stagedCount > 0">
                  <p>已在下方输入区加入 <strong>{{ stagedCount }}</strong> 张图片。</p>
                  <p class="hint">可继续添加；准备好后点击「提交焊缝检测」。</p>
                </template>
                <template v-else>
                  <p>在下方输入区选择或拖入<strong>图片</strong>（不会立即检测）。</p>
                  <p class="hint">首次提交后，输入区会移至页面底部，结果展示在上方。</p>
                </template>
              </div>

              <div v-else class="result-list-wrap">
                <table class="result-table" aria-label="检测结果列表">
                  <thead>
                    <tr>
                      <th scope="col">文件名</th>
                      <th scope="col">状态</th>
                      <th scope="col" class="result-table-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in resultListVisibleItems" :key="item.id">
                      <td class="result-table-name" :title="item.relativePath">{{ item.relativePath }}</td>
                      <td>
                        <span class="badge" :data-status="item.status">{{ statusLabel(item.status) }}</span>
                      </td>
                      <td class="result-table-actions">
                        <button type="button" class="btn btn-sm" @click="openDetail(item.id)">查看详情</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <nav
                  v-if="resultListUsePagination"
                  class="result-pagination"
                  aria-label="结果列表分页"
                >
                  <div class="result-pagination-info">
                    第 <strong>{{ resultListPage }}</strong> / {{ resultListTotalPages }} 页，每页
                    {{ RESULT_LIST_PAGE_SIZE }} 张，共 {{ resultListTotalCount }} 张
                  </div>
                  <div class="result-pagination-row">
                    <button
                      type="button"
                      class="btn btn-sm"
                      :disabled="resultListPage <= 1"
                      @click="goResultPrevPage"
                    >
                      上一页
                    </button>
                    <div
                      v-if="resultListTotalPages <= 16"
                      class="result-page-nums"
                      role="navigation"
                      aria-label="页码"
                    >
                      <button
                        v-for="p in resultListPageNumbers"
                        :key="p"
                        type="button"
                        class="btn btn-page"
                        :class="{ 'btn-page--active': p === resultListPage }"
                        :aria-current="p === resultListPage ? 'page' : undefined"
                        @click="goResultPage(p)"
                      >
                        {{ p }}
                      </button>
                    </div>
                    <button
                      type="button"
                      class="btn btn-sm"
                      :disabled="resultListPage >= resultListTotalPages"
                      @click="goResultNextPage"
                    >
                      下一页
                    </button>
                  </div>
                  <div class="result-pagination-jump">
                    <label class="result-pagination-jump-label" for="result-list-jump-float">跳转到</label>
                    <input
                      id="result-list-jump-float"
                      v-model.number="resultListJumpDraft"
                      class="result-pagination-jump-input"
                      type="number"
                      min="1"
                      :max="resultListTotalPages"
                      @keydown.enter.prevent="commitResultListJump"
                    />
                    <button type="button" class="btn btn-sm" @click="commitResultListJump">确定</button>
                  </div>
                </nav>
              </div>
            </section>

            <div class="composer-slot">
              <div class="composer-stack">
                <p v-if="uploadError" class="composer-error" role="status">{{ uploadError }}</p>
                <div
                  class="composer-panel"
                  :class="{ 'drag-over': dragOver, 'has-staged': stagedCount > 0 }"
                  role="group"
                  aria-label="待检测：选择或拖入图片，提交后开始检测"
                >
                  <div v-if="stagedCount > 0" class="staged-strip">
                    <div v-for="item in stagedItems" :key="item.id" class="staged-chip">
                      <div class="staged-chip-img">
                        <img :src="item.previewUrl" :alt="item.file.name" />
                      </div>
                      <span class="staged-chip-cap" :title="stagedCaption(item.file)">{{ stagedCaption(item.file) }}</span>
                      <button
                        type="button"
                        class="staged-chip-remove"
                        title="从待检测列表移除"
                        aria-label="移除"
                        @click.stop="removeStagedItem(item.id)"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div class="composer-pill-row">
                    <div class="pill-readonly" aria-readonly="true" tabindex="-1">
                      <template v-if="dragOver">
                        <span class="pill-placeholder pill-drag-title">松开以加入待检测列表</span>
                        <span class="pill-note">支持<strong>图片</strong>或<strong>文件夹</strong>（须全部为图片）</span>
                      </template>
                      <template v-else>
                        <span class="pill-placeholder">
                          {{ stagedCount > 0 ? `待检测 ${stagedCount} 张` : '添加待检测图片' }}
                        </span>
                        <span class="pill-note">提交检测后，本输入区将移至页面底部</span>
                      </template>
                    </div>
                    <div class="pill-actions">
                      <button type="button" class="btn" @click="imageInputRef?.click()">选择图片</button>
                      <button type="button" class="btn" @click="folderInputRef?.click()">选择文件夹</button>
                      <button
                        type="button"
                        class="btn btn-submit"
                        :disabled="submitDisabled"
                        @click="void submitWeldInspection()"
                      >
                        提交焊缝检测
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <input
                ref="imageInput"
                class="hidden-input"
                type="file"
                accept="image/*"
                multiple
                @change="onImagePicked"
              />
              <input
                ref="folderInput"
                class="hidden-input"
                type="file"
                multiple
                webkitdirectory
                @change="onFolderPicked"
              />
            </div>
          </div>
        </template>
      </div>
    </main>
  </div>

  <Teleport to="body">
    <div
      v-if="deleteConfirmBatchId"
      class="del-modal-overlay"
      role="presentation"
      @click.self="closeDeleteConfirm"
    >
      <div
        class="del-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="del-modal-title"
        aria-describedby="del-modal-desc"
        @click.stop
      >
        <h2 id="del-modal-title" class="del-modal-title">删除上传记录</h2>
        <p id="del-modal-desc" class="del-modal-desc">
          确定删除这条记录？删除后无法恢复。
        </p>
        <p v-if="deleteConfirmLabel" class="del-modal-preview">{{ deleteConfirmLabel }}</p>
        <p v-if="deleteConfirmMeta" class="del-modal-meta">{{ deleteConfirmMeta }}</p>
        <div class="del-modal-actions">
          <button type="button" class="del-modal-btn del-modal-btn-muted" @click="closeDeleteConfirm">
            取消
          </button>
          <button type="button" class="del-modal-btn del-modal-btn-danger" @click="commitDeleteConfirm">
            删除
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div
      v-if="detailItem"
      class="detail-drawer-overlay"
      role="presentation"
      @click.self="closeDetail"
    >
      <aside
        class="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-drawer-title"
        @click.stop
      >
        <header class="detail-drawer-head">
          <h2 id="detail-drawer-title" class="detail-drawer-title">{{ detailItem.relativePath }}</h2>
          <button type="button" class="detail-drawer-close" aria-label="关闭" @click="closeDetail">
            关闭
          </button>
        </header>
        <div class="detail-drawer-body">
          <section class="detail-zoom-section" aria-label="原图">
            <div class="detail-zoom-head">
              <h3 class="detail-zoom-label">原图</h3>
              <div class="detail-zoom-tools">
                <button type="button" class="btn btn-tiny" @click="bumpOriginalZoom(-0.25)">缩小</button>
                <span class="detail-zoom-pct">{{ Math.round(detailZoomOriginal * 100) }}%</span>
                <button type="button" class="btn btn-tiny" @click="bumpOriginalZoom(0.25)">放大</button>
              </div>
            </div>
            <div class="detail-zoom-viewport">
              <img
                class="detail-zoom-img"
                :src="detailItem.originalUrl"
                :alt="detailItem.name"
                :style="{ width: `${100 * detailZoomOriginal}%` }"
              />
            </div>
          </section>
          <section class="detail-zoom-section" aria-label="分割结果">
            <div class="detail-zoom-head">
              <h3 class="detail-zoom-label">分割结果</h3>
              <div class="detail-zoom-tools">
                <button type="button" class="btn btn-tiny" @click="bumpResultZoom(-0.25)">缩小</button>
                <span class="detail-zoom-pct">{{ Math.round(detailZoomResult * 100) }}%</span>
                <button type="button" class="btn btn-tiny" @click="bumpResultZoom(0.25)">放大</button>
              </div>
            </div>
            <div class="detail-zoom-viewport">
              <img
                v-if="detailItem.resultUrl"
                class="detail-zoom-img"
                :src="detailItem.resultUrl"
                alt="分割结果"
                :style="{ width: `${100 * detailZoomResult}%` }"
              />
              <div v-else class="detail-result-placeholder">
                <template v-if="detailItem.status === 'running'">处理中…</template>
                <template v-else-if="detailItem.status === 'error'">
                  <span class="detail-result-err">{{ detailItem.error }}</span>
                </template>
                <template v-else>暂无分割图（等待处理）</template>
              </div>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.studio {
  display: flex;
  height: 100vh;
  width: 100%;
  background: #0f0f12;
  color: #ececf1;
  font-family:
    'Segoe UI',
    system-ui,
    -apple-system,
    sans-serif;
}

.sidebar {
  width: 272px;
  flex-shrink: 0;
  border-right: 1px solid #2f2f35;
  display: flex;
  flex-direction: column;
  background: #16161a;
}

.brand {
  padding: 1rem 1rem 0.75rem;
  border-bottom: 1px solid #2f2f35;
}

.brand-title {
  display: block;
  font-weight: 600;
  font-size: 1rem;
}

.brand-sub {
  font-size: 0.8rem;
  color: #9b9ba5;
}

.history {
  flex: 1;
  overflow: auto;
  padding: 0.5rem;
}

.history-item {
  width: 100%;
  display: flex;
  align-items: stretch;
  gap: 0.25rem;
  border: 1px solid transparent;
  border-radius: 8px;
  margin-bottom: 0.35rem;
  background: transparent;
  color: inherit;
  transition: background 0.15s, border-color 0.15s;
  overflow: hidden;
}

.history-item:hover {
  background: #1f1f26;
}

.history-item.active {
  background: #26262e;
  border-color: #3f3f4a;
}

.history-select {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0.65rem 0.5rem 0.65rem 0.75rem;
  font: inherit;
}

.history-delete {
  flex-shrink: 0;
  align-self: center;
  margin-right: 0.35rem;
  padding: 0.25rem 0.45rem;
  font-size: 0.72rem;
  color: #a8a8b3;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.history-delete:hover {
  color: #f0a4a4;
  background: rgba(240, 164, 164, 0.12);
}

.history-label {
  display: block;
  font-size: 0.82rem;
  line-height: 1.35;
  word-break: break-word;
}

.history-meta {
  font-size: 0.72rem;
  color: #8e8e98;
}

.history-empty {
  padding: 1rem;
  font-size: 0.85rem;
  color: #7a7a85;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #121215;
}

.toolbar {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 0.75rem 1.25rem 0.85rem;
  border-bottom: 1px solid #2a2a30;
  background: transparent;
  flex-shrink: 0;
}

.page-title {
  font-size: 1.05rem;
  font-weight: 600;
}

.toolbar-status {
  font-size: 0.85rem;
  color: #c4c4ce;
}

.toolbar-staged {
  font-size: 0.85rem;
  color: #8eb5ff;
}

.main-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
}

.main-body--docked {
  min-height: 0;
}

.main-center-column {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: stretch;
  padding: 0 0 0.5rem;
  overflow: hidden;
}

.scroll {
  min-width: 0;
  padding: 1rem 1.25rem;
  overflow: auto;
}

.scroll.scroll--dock {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 1rem 1.15rem 1rem;
}

.scroll.scroll--floating {
  flex: 0 1 auto;
  max-height: min(36vh, 280px);
  min-height: 0;
  overflow-y: auto;
}

.placeholder {
  max-width: 480px;
  margin: 2rem auto;
  text-align: center;
  color: #b4b4bf;
  line-height: 1.6;
}

.main-center-column .placeholder {
  margin: 0.5rem auto 0.75rem;
}

.placeholder .hint {
  margin-top: 0.5rem;
  font-size: 0.88rem;
  color: #8a8a96;
}

.progress-center-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: min(16vh, 5.5rem);
  padding-bottom: 2rem;
  padding-left: 1rem;
  padding-right: 1rem;
}

.progress-center-card {
  width: 100%;
  max-width: 56rem;
  border-radius: 14px;
  border: 1px solid #3a3a42;
  background: #16161a;
  padding: 1.25rem 1.35rem 1.2rem;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.progress-center-title {
  margin: 0 0 1rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: #e2e2ea;
  letter-spacing: 0.02em;
}

.progress-lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.progress-line {
  font-size: 0.95rem;
  line-height: 1.5;
  color: #c4c4ce;
  word-break: break-word;
}

.progress-line[data-tag='完成'] .progress-bracket {
  color: #6ee7a8;
}

.progress-line[data-tag='错误'] .progress-bracket {
  color: #f0a4a4;
}

.progress-line[data-tag='处理中'] .progress-bracket {
  color: #8eb5ff;
}

.progress-bracket {
  font-weight: 600;
  margin-right: 0.35rem;
}

.progress-text {
  color: #b8b8c4;
}

.progress-cursor {
  display: inline-block;
  margin-left: 1px;
  color: #8eb5ff;
  font-weight: 300;
  animation: progress-cursor-blink 0.85s step-end infinite;
}

@keyframes progress-cursor-blink {
  50% {
    opacity: 0;
  }
}

.progress-inline {
  width: 100%;
  max-width: 56rem;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 1rem;
  padding: 0.85rem 1.15rem;
  box-sizing: border-box;
  border-radius: 12px;
  border: 1px solid #2f2f35;
  background: #16161a;
}

.progress-inline-title {
  margin: 0 0 0.55rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: #9b9ba5;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.progress-lines--compact {
  gap: 0.4rem;
  max-height: 11rem;
  overflow-y: auto;
}

.progress-lines--compact .progress-line {
  font-size: 0.9rem;
}

.scroll.scroll--dock .result-list-wrap {
  width: 100%;
  max-width: 56rem;
  margin-left: auto;
  margin-right: auto;
}

.result-list-wrap {
  width: 100%;
  border-radius: 12px;
  border: 1px solid #2f2f35;
  background: #16161a;
  overflow: hidden;
}

.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.result-table th,
.result-table td {
  padding: 0.65rem 0.85rem;
  text-align: left;
  border-bottom: 1px solid #2a2a30;
}

.result-table th {
  font-weight: 600;
  font-size: 0.78rem;
  color: #9b9ba5;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: #141418;
}

.result-table tbody tr:last-child td {
  border-bottom: none;
}

.result-table tbody tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}

.result-table-name {
  color: #c8c8d2;
  word-break: break-word;
  max-width: 0;
  width: 55%;
}

.result-table-actions {
  width: 8.5rem;
  white-space: nowrap;
  vertical-align: middle;
}

.result-pagination {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.75rem 0.85rem;
  border-top: 1px solid #2a2a30;
  background: #141418;
}

.result-pagination-info {
  font-size: 0.8rem;
  color: #9b9ba5;
  line-height: 1.45;
}

.result-pagination-info strong {
  color: #c8c8d2;
  font-weight: 600;
}

.result-pagination-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.result-page-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  max-width: 100%;
}

.btn-page {
  min-width: 2rem;
  padding: 0.3rem 0.45rem;
  font-size: 0.78rem;
  border-radius: 6px;
  border: 1px solid #3f3f4a;
  background: #1f1f26;
  color: #c4c4ce;
  cursor: pointer;
  font-family: inherit;
}

.btn-page:hover {
  background: #2a2a32;
}

.btn-page--active {
  background: #2a3148;
  border-color: #4a6aad;
  color: #dce6ff;
  font-weight: 600;
}

.result-pagination-jump {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
}

.result-pagination-jump-label {
  color: #8e8e98;
}

.result-pagination-jump-input {
  width: 4rem;
  padding: 0.35rem 0.45rem;
  border-radius: 6px;
  border: 1px solid #3f3f4a;
  background: #0f0f12;
  color: #ececf1;
  font-size: 0.85rem;
  font-family: inherit;
}

.result-pagination-jump-input:focus {
  outline: none;
  border-color: #5b8cff;
  box-shadow: 0 0 0 2px rgba(91, 140, 255, 0.2);
}

.btn-sm {
  padding: 0.35rem 0.65rem;
  font-size: 0.82rem;
  border-radius: 8px;
}

.btn-tiny {
  padding: 0.28rem 0.5rem;
  font-size: 0.75rem;
  border-radius: 6px;
}

.badge {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: #2a2a32;
  color: #a8a8b3;
}

.badge[data-status='pending'] {
  background: #2a2a32;
  color: #9b9ba5;
}

.badge[data-status='done'] {
  background: #143d29;
  color: #7ae2a9;
}

.badge[data-status='error'] {
  background: #3d1414;
  color: #f0a4a4;
}

.badge[data-status='running'] {
  background: #2a3148;
  color: #a8c4ff;
}

.detail-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
}

.detail-drawer {
  width: min(100vw - 1rem, 520px);
  max-width: 100%;
  background: #1a1a1f;
  border-left: 1px solid #3a3a42;
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  min-height: 0;
  animation: detail-drawer-in 0.22s ease-out;
}

@keyframes detail-drawer-in {
  from {
    transform: translateX(100%);
    opacity: 0.85;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.detail-drawer-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1rem 0.85rem;
  border-bottom: 1px solid #2f2f35;
}

.detail-drawer-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.4;
  color: #e2e2ea;
  word-break: break-word;
}

.detail-drawer-close {
  flex-shrink: 0;
  border: 1px solid #3f3f4a;
  background: #2a2a32;
  color: #ececf1;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
  font-family: inherit;
}

.detail-drawer-close:hover {
  background: #34343e;
}

.detail-drawer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.detail-zoom-section {
  border: 1px solid #2f2f35;
  border-radius: 10px;
  background: #141418;
  padding: 0.65rem 0.75rem 0.75rem;
}

.detail-zoom-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.detail-zoom-label {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: #9b9ba5;
}

.detail-zoom-tools {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.detail-zoom-pct {
  font-size: 0.72rem;
  color: #8e8e98;
  min-width: 2.75rem;
  text-align: center;
}

.detail-zoom-viewport {
  max-height: min(38vh, 320px);
  overflow: auto;
  border-radius: 8px;
  background: #0b0b0e;
  border: 1px solid #2a2a30;
}

.detail-zoom-img {
  display: block;
  height: auto;
  max-width: none;
}

.detail-result-placeholder {
  min-height: 8rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  font-size: 0.88rem;
  color: #9b9ba5;
  text-align: center;
}

.detail-result-err {
  color: #ffb4b4;
  word-break: break-word;
  line-height: 1.45;
}

.composer-slot {
  flex: 0 0 auto;
  width: 100%;
  max-width: 58rem;
  margin: 0 auto;
  padding: 0 1rem 1.25rem;
  align-self: center;
  transition:
    padding 0.35s ease,
    max-width 0.35s ease;
}

.composer-slot--docked {
  align-self: stretch;
  max-width: none;
  padding: 0.85rem 1.15rem 1.25rem;
  border-top: 1px solid #2f2f35;
  background: linear-gradient(to top, #121215 0%, #121215 88%, rgba(18, 18, 21, 0.94));
}

.composer-stack {
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.composer-error {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  font-size: 0.82rem;
  line-height: 1.45;
  color: #ffb4b4;
  background: rgba(92, 32, 32, 0.35);
  border: 1px solid rgba(240, 164, 164, 0.25);
}

.composer-panel {
  width: 100%;
  border-radius: 22px;
  border: 1px solid #3a3a42;
  background: #1a1a1f;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
  overflow: hidden;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease;
  user-select: none;
}

.composer-panel.drag-over {
  border-color: #5b8cff;
  box-shadow:
    0 0 0 1px rgba(91, 140, 255, 0.35) inset,
    0 0 0 3px rgba(59, 130, 246, 0.18);
  background: #1e2430;
}

.staged-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.65rem 0.75rem;
  max-height: min(48vh, 20rem);
  overflow-y: auto;
  border-bottom: 1px solid #2f2f35;
  background: #141418;
}

.staged-chip {
  position: relative;
  flex: 0 0 auto;
  width: 5.35rem;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #33333c;
  background: #0f0f12;
}

.staged-chip-img {
  aspect-ratio: 1;
  width: 100%;
  background: #0b0b0e;
}

.staged-chip-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.staged-chip-cap {
  font-size: 0.62rem;
  line-height: 1.25;
  color: #8e8e98;
  padding: 0.25rem 0.3rem 0.35rem;
  max-height: 2.6em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  word-break: break-word;
}

.staged-chip-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 1.35rem;
  height: 1.35rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #f0f0f5;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s;
}

.staged-chip-remove:hover {
  background: rgba(80, 30, 30, 0.85);
  color: #ffb4b4;
}

.composer-pill-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0.75rem 1rem 0.85rem 1.35rem;
  min-height: 4.15rem;
}

.pill-readonly {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.25rem 0;
  cursor: default;
  outline: none;
}

.pill-readonly:focus-visible {
  box-shadow: none;
}

.pill-placeholder {
  font-size: 1.02rem;
  color: #c4c4ce;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-drag-title {
  font-size: 1.08rem;
  font-weight: 600;
  color: #e8eeff;
}

.pill-note {
  font-size: 0.8rem;
  color: #6f6f7a;
  line-height: 1.4;
  white-space: normal;
}

.pill-note :deep(strong) {
  color: #9ea8c8;
  font-weight: 600;
}

.pill-actions {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.pill-actions .btn {
  border-radius: 9999px;
  padding: 0.52rem 1.05rem;
  font-size: 0.9rem;
}

.pill-actions .btn-submit {
  min-width: 9.5rem;
}

.btn {
  border: 1px solid #3f3f4a;
  background: #1f1f26;
  color: #ececf1;
  padding: 0.45rem 0.9rem;
  border-radius: 8px;
  font-size: 0.88rem;
  cursor: pointer;
}

.btn:hover {
  background: #2a2a32;
}

.btn.primary {
  background: #ececf1;
  color: #121215;
  border-color: #ececf1;
}

.btn.primary:hover {
  filter: brightness(0.95);
}

.btn-submit {
  background: linear-gradient(180deg, #3b6cff 0%, #2563eb 100%);
  border-color: #3d6fd8;
  color: #fff;
  font-weight: 600;
}

.btn-submit:hover:not(:disabled) {
  filter: brightness(1.06);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.hidden-input {
  display: none;
}

.del-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

.del-modal {
  width: 100%;
  max-width: 22rem;
  border-radius: 14px;
  border: 1px solid #3a3a42;
  background: #1a1a1f;
  color: #ececf1;
  padding: 1.25rem 1.35rem 1.15rem;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}

.del-modal-title {
  margin: 0 0 0.65rem;
  font-size: 1.05rem;
  font-weight: 600;
}

.del-modal-desc {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  line-height: 1.5;
  color: #b4b4bf;
}

.del-modal-preview {
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #9b9ba5;
  word-break: break-word;
  max-height: 4.5rem;
  overflow: auto;
}

.del-modal-meta {
  margin: 0 0 1rem;
  font-size: 0.75rem;
  color: #7a7a85;
}

.del-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.del-modal-btn {
  border-radius: 8px;
  padding: 0.45rem 1rem;
  font-size: 0.88rem;
  cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}

.del-modal-btn-muted {
  background: #2a2a32;
  border-color: #3f3f4a;
  color: #ececf1;
}

.del-modal-btn-muted:hover {
  background: #34343e;
}

.del-modal-btn-danger {
  background: #5c2020;
  border-color: #7a3030;
  color: #ffd4d4;
}

.del-modal-btn-danger:hover {
  background: #702828;
}
</style>
