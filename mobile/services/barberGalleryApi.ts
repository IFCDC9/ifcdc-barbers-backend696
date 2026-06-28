import { apiFetch } from "./api";
import { apiFullUrl } from "../constants/config";
import { getAuthToken } from "./authService";

export type GalleryStyle = {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  image_url?: string;
  imageUrl?: string;
  category?: string;
  price?: number;
  barber_id?: string;
  source?: string;
};

export async function fetchBarberGallery(barberId: string | number): Promise<GalleryStyle[]> {
  const res = await apiFetch(`/api/styles/${encodeURIComponent(String(barberId))}`, { auth: false });
  const json = (await res.json()) as { styles?: GalleryStyle[]; ok?: boolean };
  if (!res.ok) return [];
  return Array.isArray(json.styles) ? json.styles : [];
}

export async function uploadBarberGalleryPhotos(
  barberId: string | number,
  uris: string[],
  opts: { title?: string; category?: string; price?: number } = {},
): Promise<GalleryStyle[]> {
  const token = await getAuthToken();
  const form = new FormData();
  for (const uri of uris) {
    const filename = uri.split("/").pop() || "style.jpg";
    form.append("files", { uri, name: filename, type: "image/jpeg" } as unknown as Blob);
  }
  form.append("barberId", String(barberId));
  form.append("title", opts.title || "Haircut");
  if (opts.category) form.append("category", opts.category);
  if (opts.price != null) form.append("price", String(opts.price));

  const url = apiFullUrl("/api/styles/batch");
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const json = (await res.json()) as { styles?: GalleryStyle[]; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || "Upload failed");
  }
  return json.styles || [];
}

export async function deleteGalleryPhoto(styleId: string): Promise<void> {
  const res = await apiFetch(`/api/styles/${encodeURIComponent(styleId)}`, { method: "DELETE" });
  if (!res.ok) {
    const json = (await res.json()) as { message?: string; error?: string };
    throw new Error(json.message || json.error || "Delete failed");
  }
}

export async function replaceGalleryPhoto(styleId: string, localUri: string): Promise<GalleryStyle> {
  const token = await getAuthToken();
  const form = new FormData();
  const filename = localUri.split("/").pop() || "style.jpg";
  form.append("image", { uri: localUri, name: filename, type: "image/jpeg" } as unknown as Blob);
  const url = apiFullUrl(`/api/styles/${encodeURIComponent(styleId)}/image`);
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const json = (await res.json()) as { style?: GalleryStyle; message?: string; error?: string };
  if (!res.ok || !json.style) {
    throw new Error(json.message || json.error || "Replace failed");
  }
  return json.style;
}
