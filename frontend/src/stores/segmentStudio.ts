import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type ItemStatus = 'pending' | 'running' | 'done' | 'error'

export interface SegmentItem {
  id: string
  /** 用于再次请求接口 */
  file: File
  name: string
  /** 选文件夹时的相对路径，纯图片则为文件名 */
  relativePath: string
  originalUrl: string
  resultUrl: string | null
  error: string | null
  status: ItemStatus
}

export interface UploadBatch {
  id: string
  createdAt: number
  /** 左侧列表展示用 */
  label: string
  items: SegmentItem[]
}

const MAX_BATCHES = 40

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function formatBatchLabel(files: File[]): string {
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (files.length === 0) return stamp
  const head = files[0]
  if (!head) return stamp
  const first = head.name
  return files.length === 1 ? `${stamp} · ${first}` : `${stamp} · ${first} 等 ${files.length} 张`
}

export const useSegmentStudioStore = defineStore('segmentStudio', () => {
  const batches = ref<UploadBatch[]>([])
  const activeBatchId = ref<string | null>(null)

  const activeBatch = computed(
    () => batches.value.find((b) => b.id === activeBatchId.value) ?? null,
  )

  function revokeItemUrls(item: SegmentItem) {
    URL.revokeObjectURL(item.originalUrl)
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
  }

  function revokeBatch(batch: UploadBatch) {
    for (const it of batch.items) revokeItemUrls(it)
  }

  function addBatchFromFiles(files: File[]): string {
    const id = uid()
    const items: SegmentItem[] = files.map((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      return {
        id: uid(),
        file,
        name: file.name,
        relativePath: rel,
        originalUrl: URL.createObjectURL(file),
        resultUrl: null,
        error: null,
        status: 'pending',
      }
    })
    const batch: UploadBatch = {
      id,
      createdAt: Date.now(),
      label: formatBatchLabel(files),
      items,
    }
    batches.value.unshift(batch)
    activeBatchId.value = id
    while (batches.value.length > MAX_BATCHES) {
      const dropped = batches.value.pop()
      if (dropped) revokeBatch(dropped)
    }
    return id
  }

  function selectBatch(batchId: string) {
    activeBatchId.value = batchId
  }

  function removeBatch(batchId: string) {
    const idx = batches.value.findIndex((b) => b.id === batchId)
    if (idx === -1) return
    const [removed] = batches.value.splice(idx, 1)
    if (removed) revokeBatch(removed)
    if (activeBatchId.value === batchId) {
      activeBatchId.value = batches.value[0]?.id ?? null
    }
  }

  function patchItem(batchId: string, itemId: string, patch: Partial<Pick<SegmentItem, 'resultUrl' | 'error' | 'status'>>) {
    const batch = batches.value.find((b) => b.id === batchId)
    if (!batch) return
    const item = batch.items.find((i) => i.id === itemId)
    if (!item) return
    if (patch.resultUrl !== undefined) {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl)
      item.resultUrl = patch.resultUrl
    }
    if (patch.error !== undefined) item.error = patch.error
    if (patch.status !== undefined) item.status = patch.status
  }

  return {
    batches,
    activeBatchId,
    activeBatch,
    addBatchFromFiles,
    selectBatch,
    removeBatch,
    patchItem,
  }
})
