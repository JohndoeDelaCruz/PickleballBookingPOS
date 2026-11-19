import { z } from "zod";

export const productPhotoTypes = ["image/jpeg", "image/png", "image/webp"];
const maxFileSize = 12 * 1024 * 1024;
const maxEncodedSize = Math.ceil(512 * 1024 / 3) * 4;
const maxSide = 768;
const imagePrefix = "data:image/jpeg;base64,";

export const productPhotoSchema = z.base64().min(1).max(maxEncodedSize);

export function productPhotoUrl(version: string | null | undefined) {
  return version ? `/staff/product-photo/${version}.jpg` : undefined;
}

export function previewProductPhoto(photo: string) {
  return imagePrefix + photo;
}

export async function prepareProductPhoto(file: File) {
  if (!productPhotoTypes.includes(file.type) || !file.size || file.size > maxFileSize) {
    throw new Error("Choose a JPG, PNG, or WebP photo up to 12 MB.");
  }
  const errorMessage = "This photo couldn’t be prepared. Try another JPG, PNG, or WebP photo.";
  const image = await createImageBitmap(file).catch(() => { throw new Error(errorMessage); });
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(errorMessage);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let preview = canvas.toDataURL("image/jpeg", 0.86);
    if (preview.length > maxEncodedSize + imagePrefix.length) preview = canvas.toDataURL("image/jpeg", 0.68);
    if (!preview.startsWith(imagePrefix) || preview.length > maxEncodedSize + imagePrefix.length) throw new Error(errorMessage);
    return preview.slice(imagePrefix.length);
  } finally {
    image.close();
  }
}
