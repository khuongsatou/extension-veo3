'use strict';

const UPLOAD_VIDEO_START_URL = 'https://flow.google.com/api/upload-video?action=start';
const MAX_VIDEO_UPLOAD_BYTES = 64 * 1024 * 1024;

function uploadedVideoMediaId(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return String(
    source.mediaGenerationId?.mediaGenerationId ||
    source.mediaGenerationId ||
    source.name ||
    source.media?.[0]?.name ||
    source.media?.name ||
    source.video?.mediaGenerationId ||
    '',
  ).trim();
}

function safeUploadVideoSessionUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !/(^|\.)googleapis\.com$/i.test(url.hostname)) return '';
    if (!url.pathname.startsWith('/upload/')) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

async function readUploadVideoResponse(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (_) { return { raw: text.slice(0, 1000) }; }
}

function safeVideoUploadError(error) {
  const name = String(error?.name || 'Error').replace(/[^a-z0-9_.:-]/gi, '').slice(0, 40) || 'Error';
  const message = String(error?.message || error || '')
    .replace(/https:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[id]')
    .slice(0, 160);
  return message ? `${name}: ${message}` : name;
}

async function fetchSignedVideoPut(sessionUrl, { projectId, fileName, bytes }) {
  const variants = [
    {
      Accept: '*/*',
      'Content-Type': 'application/octet-stream',
      'x-upload-command': 'upload',
      'x-upload-file-name': fileName,
      'x-upload-offset': '0',
      'x-upload-project-id': projectId,
      'x-upload-session-url': sessionUrl,
    },
    {
      Accept: '*/*',
      'Content-Type': 'application/octet-stream',
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-file-name': fileName,
      'x-goog-upload-offset': '0',
      'x-goog-upload-protocol': 'resumable',
    },
    { Accept: '*/*', 'Content-Type': 'application/octet-stream' },
  ];
  let lastError;
  for (const headers of variants) {
    try {
      return await fetch(sessionUrl, {
        method: 'PUT',
        headers,
        credentials: 'omit',
        body: headers['x-upload-command'] ? bytes : new Blob([bytes], { type: 'application/octet-stream' }),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('VIDEO_UPLOAD_SIGNED_PUT_FAILED');
}

async function putVideoFromFlowPage({ tabId, sessionUrl, projectId, fileName, contentType, dataBase64, requestedSize }) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (input) => {
      const safeError = (error) => {
        const name = String(error?.name || 'Error').replace(/[^a-z0-9_.:-]/gi, '').slice(0, 40) || 'Error';
        const message = String(error?.message || error || '')
          .replace(/https:\/\/[^\s"'<>]+/gi, '[url]')
          .replace(/[A-Za-z0-9_-]{24,}/g, '[id]')
          .slice(0, 160);
        return message ? `${name}: ${message}` : name;
      };
      const readResponse = async (response) => {
        const text = await response.text();
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch (_) { return { raw: text.slice(0, 1000) }; }
      };
      try {
        const parsed = new URL(String(input.sessionUrl || ''));
        if (parsed.protocol !== 'https:' || !/(^|\.)googleapis\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith('/upload/')) {
          return { ok: false, status: 502, error: 'INVALID_VIDEO_UPLOAD_SESSION' };
        }
        const binary = atob(String(input.dataBase64 || ''));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        if (bytes.byteLength !== Number(input.requestedSize || 0)) {
          return { ok: false, status: 400, error: 'VIDEO_SIZE_MISMATCH' };
        }
        const variants = [
          {
            Accept: '*/*',
            'Content-Type': input.contentType,
            'x-upload-command': 'upload',
            'x-upload-file-name': input.fileName,
            'x-upload-offset': '0',
            'x-upload-project-id': input.projectId,
            'x-upload-session-url': parsed.toString(),
          },
          {
            Accept: '*/*',
            'Content-Type': input.contentType,
            'x-goog-upload-command': 'upload, finalize',
            'x-goog-upload-file-name': input.fileName,
            'x-goog-upload-offset': '0',
            'x-goog-upload-protocol': 'resumable',
          },
          { Accept: '*/*', 'Content-Type': input.contentType },
          { 'Content-Type': input.contentType },
        ];
        let lastFetchError = '';
        for (const headers of variants) {
          try {
            const response = await fetch(parsed.toString(), {
              method: 'PUT',
              headers,
              credentials: 'omit',
              body: new Blob([bytes], { type: input.contentType || 'application/octet-stream' }),
            });
            const data = await readResponse(response);
            const mediaGenerationId = String(
              data.mediaGenerationId?.mediaGenerationId
              || data.mediaGenerationId
              || data.name
              || data.media?.[0]?.name
              || data.media?.name
              || response.headers.get('x-upload-media-id')
              || '',
            ).trim();
            return {
              ok: response.ok && Boolean(mediaGenerationId),
              status: response.status,
              error: response.ok ? (mediaGenerationId ? '' : 'VIDEO_UPLOAD_MEDIA_ID_MISSING') : 'VIDEO_UPLOAD_PAGE_PUT_FAILED',
              data: { ...data, mediaGenerationId, projectId: input.projectId, fileName: input.fileName, size: bytes.byteLength },
            };
          } catch (error) {
            lastFetchError = safeError(error);
          }
        }
        return { ok: false, status: 502, error: `VIDEO_UPLOAD_PAGE_PUT_FETCH_FAILED${lastFetchError ? `: ${lastFetchError}` : ''}`, data: { fetchError: lastFetchError } };
      } catch (error) {
        return { ok: false, status: 500, error: 'VIDEO_UPLOAD_PAGE_PUT_EXECUTION_FAILED', data: { fetchError: safeError(error) } };
      }
    },
    args: [{ sessionUrl, projectId, fileName, contentType, dataBase64, requestedSize }],
  });
  return execution?.[0]?.result || { ok: false, status: 500, error: 'VIDEO_UPLOAD_PAGE_PUT_RESULT_MISSING' };
}

async function uploadVideoFromExistingFlowTab({ projectId, fileName, contentType, dataBase64, requestedSize }) {
  const tabs = await chrome.tabs.query({
    url: FLOW_URL_PATTERNS,
  });
  const tab = tabs.find((candidate) => candidate?.id);
  if (!tab?.id) return { ok: false, status: 503, error: 'NO_FLOW_TAB' };
  const execution = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (input) => {
      const parseResponse = async (response) => {
        const text = await response.text();
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch (_) { return {}; }
      };
      try {
        let startResponse;
        try {
          startResponse = await fetch('/fx/api/upload-video?action=start', {
            method: 'POST',
            headers: {
              Accept: '*/*',
              'x-upload-content-length': String(input.requestedSize),
              'x-upload-content-type': input.contentType,
              'x-upload-file-name': input.fileName,
              'x-upload-project-id': input.projectId,
            },
            credentials: 'include',
          });
        } catch (_) {
          return { ok: false, status: 502, error: 'VIDEO_UPLOAD_PAGE_START_FETCH_FAILED' };
        }
        const startData = await parseResponse(startResponse);
        if (!startResponse.ok) return { ok: false, status: startResponse.status, error: 'VIDEO_UPLOAD_START_FAILED' };
        let sessionUrl = '';
        try {
          const parsed = new URL(String(startData.sessionUrl || ''));
          if (parsed.protocol === 'https:' && /(^|\.)googleapis\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/upload/')) {
            sessionUrl = parsed.toString();
          }
        } catch (_) {}
        if (!sessionUrl) return { ok: false, status: 502, error: 'INVALID_VIDEO_UPLOAD_SESSION' };
        return { ok: true, status: startResponse.status, sessionUrl };
      } catch (error) {
        return { ok: false, status: 500, error: error?.message || 'VIDEO_UPLOAD_PAGE_FAILED' };
      }
    },
    args: [{ projectId, fileName, contentType, requestedSize }],
  });
  const started = execution?.[0]?.result || { ok: false, status: 500, error: 'VIDEO_UPLOAD_PAGE_RESULT_MISSING' };
  if (!started.ok) return started;
  const sessionUrl = safeUploadVideoSessionUrl(started.sessionUrl);
  if (!sessionUrl) return { ok: false, status: 502, error: 'INVALID_VIDEO_UPLOAD_SESSION' };

  let bytes;
  try {
    const binary = atob(dataBase64);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (_) {
    return { ok: false, status: 400, error: 'INVALID_VIDEO_BASE64' };
  }
  if (bytes.byteLength !== requestedSize) return { ok: false, status: 400, error: 'VIDEO_SIZE_MISMATCH' };

  let uploadResponse;
  try {
    uploadResponse = await fetchSignedVideoPut(sessionUrl, { projectId, fileName, bytes });
  } catch (error) {
    const pagePut = await putVideoFromFlowPage({
      tabId: tab.id,
      sessionUrl,
      projectId,
      fileName,
      contentType,
      dataBase64,
      requestedSize,
    });
    if (pagePut.ok) return pagePut;
    return {
      ok: false,
      status: pagePut.status || 502,
      error: pagePut.error || 'VIDEO_UPLOAD_PAGE_START_WORKER_PUT_FETCH_FAILED',
      data: {
        ...(pagePut.data || {}),
        workerPutFetchError: safeVideoUploadError(error),
      },
    };
  }
  const uploadData = await readUploadVideoResponse(uploadResponse);
  if (!uploadResponse.ok) return { ok: false, status: uploadResponse.status, error: 'VIDEO_UPLOAD_PUT_FAILED' };
  const mediaGenerationId = uploadedVideoMediaId(uploadData)
    || String(uploadResponse.headers.get('x-upload-media-id') || '').trim();
  return {
    ok: Boolean(mediaGenerationId),
    status: uploadResponse.status,
    error: mediaGenerationId ? '' : 'VIDEO_UPLOAD_MEDIA_ID_MISSING',
    data: { mediaGenerationId, projectId, fileName, size: bytes.byteLength },
  };
}

async function handleUploadVideo(msg) {
  const { id, params = {} } = msg;
  const projectId = String(params.projectId || '').replace(/^projects\//, '').trim();
  const fileName = String(params.fileName || '').split(/[\\/]/).pop().trim();
  const contentType = String(params.contentType || 'video/mp4').trim().toLowerCase();
  const dataBase64 = String(params.dataBase64 || '').replace(/^data:[^,]+,/, '');
  const requestedSize = Number(params.size || 0);
  if (!projectId || !fileName || !/^video\/[a-z0-9.+-]+$/i.test(contentType) || !dataBase64) {
    sendToAgent({ id, status: 400, error: 'INVALID_VIDEO_UPLOAD' });
    return;
  }
  if (!Number.isSafeInteger(requestedSize) || requestedSize <= 0 || requestedSize > MAX_VIDEO_UPLOAD_BYTES) {
    sendToAgent({ id, status: 413, error: 'VIDEO_UPLOAD_TOO_LARGE' });
    return;
  }
  let bytes;
  try {
    const binary = atob(dataBase64);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (_) {
    sendToAgent({ id, status: 400, error: 'INVALID_VIDEO_BASE64' });
    return;
  }
  if (bytes.byteLength !== requestedSize) {
    sendToAgent({ id, status: 400, error: 'VIDEO_SIZE_MISMATCH' });
    return;
  }

  setState('running');
  let serviceWorkerFetchStage = 'VIDEO_UPLOAD_SW_START_FETCH_FAILED';
  try {
    const startResponse = await fetch(UPLOAD_VIDEO_START_URL, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'x-upload-content-length': String(bytes.byteLength),
        'x-upload-content-type': contentType,
        'x-upload-file-name': fileName,
        'x-upload-project-id': projectId,
        Referer: `https://flow.google.com/project/${encodeURIComponent(projectId)}`,
      },
      credentials: 'include',
    });
    const startData = await readUploadVideoResponse(startResponse);
    if (!startResponse.ok) {
      sendToAgent({ id, status: startResponse.status, data: startData });
      return;
    }
    const sessionUrl = safeUploadVideoSessionUrl(startData.sessionUrl);
    if (!sessionUrl) {
      sendToAgent({ id, status: 502, error: 'INVALID_VIDEO_UPLOAD_SESSION' });
      return;
    }

    serviceWorkerFetchStage = 'VIDEO_UPLOAD_SW_PUT_FETCH_FAILED';
    const uploadResponse = await fetchSignedVideoPut(sessionUrl, { projectId, fileName, bytes });
    const uploadData = await readUploadVideoResponse(uploadResponse);
    if (!uploadResponse.ok) {
      sendToAgent({ id, status: uploadResponse.status, data: uploadData });
      return;
    }
    const mediaGenerationId = uploadedVideoMediaId(uploadData)
      || String(uploadResponse.headers.get('x-upload-media-id') || '').trim();
    sendToAgent({
      id,
      status: uploadResponse.status,
      data: { ...uploadData, mediaGenerationId, projectId, fileName, size: bytes.byteLength },
    });
  } catch (_) {
    try {
      const fallback = await uploadVideoFromExistingFlowTab({ projectId, fileName, contentType, dataBase64, requestedSize });
      if (fallback.ok) sendToAgent({ id, status: fallback.status || 200, data: fallback.data });
      else sendToAgent({
        id,
        status: fallback.status || 500,
        error: fallback.error || serviceWorkerFetchStage,
        data: { serviceWorkerFetchStage },
      });
    } catch (_) {
      sendToAgent({ id, status: 500, error: 'VIDEO_UPLOAD_PAGE_EXECUTION_FAILED', data: { serviceWorkerFetchStage } });
    }
  } finally {
    setState('idle');
  }
}
