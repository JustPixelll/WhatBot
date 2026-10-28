export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class ImageInputError extends Error {}

export function validateImage(media, maxBytes = MAX_IMAGE_BYTES) {
  if (!media || !TYPES.has(media.mimetype)) throw new ImageInputError('Bitte ein normales Foto als JPEG, PNG, WebP oder GIF senden.');
  const data = media.data;
  if (typeof data !== 'string' || !data.length) throw new ImageInputError('Das Foto ist nicht mehr verfügbar. Bitte erneut senden.');
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new ImageInputError('Das Bild ist zu groß. Bitte ein Foto unter 5 MB senden.');
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ImageInputError('Das Bild konnte nicht gelesen werden. Bitte erneut senden.');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new ImageInputError('Das Bild ist zu groß oder leer. Bitte ein Foto unter 5 MB senden.');
  const valid = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/gif': ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)),
    'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  }[media.mimetype];
  if (!valid) throw new ImageInputError('Das Bildformat ist ungültig. Bitte das Foto erneut senden.');
  return { mimetype: media.mimetype, data };
}

// Called only after the engine checks address, group, age, cooldown and budget.
export async function loadMessageImage(message, { signal, timeoutMs = 30000 } = {}) {
  const work = async () => {
    let photo = message.type === 'image' ? message : null;
    if (!photo && message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      if (quoted?.type === 'image') {
        if (quoted.from !== message.from && quoted.to !== message.from) throw new ImageInputError('Bitte auf ein Foto in dieser Gruppe antworten.');
        photo = quoted;
      } else if (quoted?.hasMedia) {
        throw new ImageInputError('Ich kann hier nur normale Fotos ansehen, keine Videos, Dokumente oder Sticker.');
      }
    }
    if (!photo) return null;
    if (photo.isViewOnce || photo.rawData?.isViewOnce) throw new ImageInputError('Einmalansicht wird nicht verarbeitet. Bitte ein normales Foto senden.');
    if (Number(photo.rawData?.size) > MAX_IMAGE_BYTES) throw new ImageInputError('Bitte ein Foto unter 5 MB senden.');
    if (!photo.hasMedia) throw new ImageInputError('Das Foto ist nicht mehr verfügbar. Bitte erneut senden.');
    return validateImage(await photo.downloadMedia());
  };
  let timer, onAbort;
  try {
    if (signal?.aborted) throw new Error('Stopped.');
    return await Promise.race([
      work(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new ImageInputError('Das Foto konnte nicht rechtzeitig geladen werden. Bitte erneut versuchen.')), timeoutMs);
        onAbort = () => reject(new Error('Stopped.'));
        signal?.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
