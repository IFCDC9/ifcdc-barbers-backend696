import * as ImageManipulator from "expo-image-manipulator";

/** Resize and compress review photos before upload for faster loading. */
export async function compressReviewPhoto(uri: string): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1600 } }],
    { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
  );
  return result.uri;
}
