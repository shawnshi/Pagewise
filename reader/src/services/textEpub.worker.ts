/// <reference lib="webworker" />
import { convertToEpubLocal } from './textToEpub'

self.onmessage = async (event: MessageEvent<{ blob: Blob; fileName: string; format: 'txt' }>) => {
  try {
    const { blob, fileName, format } = event.data
    if (!(blob instanceof Blob) || typeof fileName !== 'string' || format !== 'txt') throw new Error('Invalid text conversion request')
    self.postMessage(await convertToEpubLocal(blob, fileName, format))
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Text conversion failed' })
  }
}
