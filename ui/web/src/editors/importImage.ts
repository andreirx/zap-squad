/**
 * Import an image file (PNG, JPG) into an ImageData suitable for the pixel editors.
 *
 * Scales the image to fit within targetSize × targetSize while maintaining
 * aspect ratio. The image is centered on a transparent canvas; remaining
 * pixels are transparent black (RGBA 0,0,0,0).
 *
 * Used by TileEditor, CharacterEditor, and ObjectEditor to import external
 * artwork as the current frame or variation.
 */

const LOG = '[importImage]';

/** Open a file picker and return the selected File, or null if cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    console.log(`${LOG} opening file picker...`);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg';
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      if (file) {
        console.log(`${LOG} file selected: "${file.name}" type=${file.type} size=${file.size} bytes`);
      } else {
        console.log(`${LOG} onchange fired but no file in input.files`);
      }
      resolve(file);
    };
    input.addEventListener('cancel', () => {
      console.log(`${LOG} file picker cancelled`);
      resolve(null);
    });
    input.click();
  });
}

/** Load a File as an HTMLImageElement. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    console.log(`${LOG} loading image from blob URL: ${url}`);
    const img = new Image();
    img.onload = () => {
      console.log(`${LOG} image loaded: ${img.width}x${img.height} naturalSize=${img.naturalWidth}x${img.naturalHeight}`);
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      console.error(`${LOG} image load FAILED for "${file.name}":`, e);
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image: ${file.name}`));
    };
    img.src = url;
  });
}

/**
 * Import an image file, scale to fit targetSize × targetSize, and return
 * as ImageData ready for PixelCanvas.setImageData().
 *
 * Scale-to-fit: the image is scaled so the larger dimension equals
 * targetSize. The smaller dimension is centered with transparent padding.
 *
 * Returns null if the user cancels the file picker.
 */
export async function importImageToImageData(
  targetSize: number,
): Promise<{ imageData: ImageData; fileName: string } | null> {
  console.log(`${LOG} importImageToImageData called, targetSize=${targetSize}`);

  let file: File | null;
  try {
    file = await pickImageFile();
  } catch (err) {
    console.error(`${LOG} pickImageFile threw:`, err);
    return null;
  }
  if (!file) {
    console.log(`${LOG} no file selected, returning null`);
    return null;
  }

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch (err) {
    console.error(`${LOG} loadImage threw:`, err);
    return null;
  }

  if (img.width === 0 || img.height === 0) {
    console.error(`${LOG} image has zero dimensions: ${img.width}x${img.height}`);
    return null;
  }

  // Compute scale-to-fit dimensions
  const scale = Math.min(targetSize / img.width, targetSize / img.height);
  const scaledW = Math.round(img.width * scale);
  const scaledH = Math.round(img.height * scale);
  const offsetX = Math.floor((targetSize - scaledW) / 2);
  const offsetY = Math.floor((targetSize - scaledH) / 2);

  console.log(`${LOG} scaling: ${img.width}x${img.height} -> ${scaledW}x${scaledH} (scale=${scale.toFixed(3)}) offset=(${offsetX},${offsetY})`);

  // Use an offscreen canvas to do the scaling + compositing
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error(`${LOG} failed to get 2d context from offscreen canvas`);
    return null;
  }

  // Transparent background (default for canvas)
  // Disable image smoothing for pixel art (nearest-neighbor scaling)
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, offsetX, offsetY, scaledW, scaledH);

  const imageData = ctx.getImageData(0, 0, targetSize, targetSize);

  // Verify the ImageData has actual pixel content
  let nonZeroPixels = 0;
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] > 0) nonZeroPixels++;
  }
  console.log(`${LOG} result: ${targetSize}x${targetSize} ImageData, ${nonZeroPixels}/${targetSize * targetSize} non-transparent pixels`);

  if (nonZeroPixels === 0) {
    console.warn(`${LOG} WARNING: imported image produced zero visible pixels — image may be fully transparent`);
  }

  return { imageData, fileName: file.name };
}
