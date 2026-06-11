-- =============================================================================
-- Storage RLS — run in Supabase SQL Editor only (requires owner on storage.objects)
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'barber-styles',
  'barber-styles',
  true,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "barber_styles_public_read" ON storage.objects;
DROP POLICY IF EXISTS "barber_styles_auth_insert_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "barber_styles_auth_update_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "barber_styles_auth_delete_own_folder" ON storage.objects;

CREATE POLICY "barber_styles_public_read"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'barber-styles');

CREATE POLICY "barber_styles_auth_insert_own_folder"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'barber-styles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "barber_styles_auth_update_own_folder"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'barber-styles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "barber_styles_auth_delete_own_folder"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'barber-styles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
