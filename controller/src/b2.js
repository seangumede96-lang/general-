// Backblaze B2, native API: list files and make short-lived download links. The pod is
// given links, never keys, so the keys stay on the phone.
const REAL = 'https://api.backblazeb2.com';

export class B2Error extends Error {}

export async function openB2({ keyId, appKey, bucket, apiBase = REAL }) {
	if (!keyId || !appKey || !bucket) throw new B2Error('Backblaze is not set up yet.');
	const call = async (url, init) => {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }).catch(() => null);
		const body = res ? await res.json().catch(() => ({})) : {};
		if (!res?.ok) throw new B2Error(`Backblaze: ${body.message || body.code || (res ? `HTTP ${res.status}` : 'could not connect')}`);
		return body;
	};
	const auth = await call(`${apiBase}/b2api/v3/b2_authorize_account`, { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` } });
	const { apiUrl, downloadUrl } = auth.apiInfo.storageApi;
	const post = (name, body) => call(`${apiUrl}/b2api/v3/${name}`, { method: 'POST', headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	// A key limited to one bucket reports its id; otherwise look the bucket up by name.
	let bucketId = auth.apiInfo.storageApi.bucketName === bucket ? auth.apiInfo.storageApi.bucketId : null;
	if (!bucketId) bucketId = (await post('b2_list_buckets', { accountId: auth.accountId, bucketName: bucket })).buckets?.[0]?.bucketId;
	if (!bucketId) throw new B2Error(`Backblaze: no bucket called "${bucket}" is visible to this key.`);

	return {
		async list(prefix) {
			const { files = [] } = await post('b2_list_file_names', { bucketId, prefix, maxFileCount: 200 });
			return files.filter((f) => f.action === 'upload' || !f.action).map((f) => ({ name: f.fileName, size: f.contentLength }));
		},
		/** A link that downloads exactly this file for a limited time. */
		async link(fileName, seconds = 3600) {
			const { authorizationToken } = await post('b2_get_download_authorization', { bucketId, fileNamePrefix: fileName, validDurationInSeconds: seconds });
			return `${downloadUrl}/file/${bucket}/${fileName.split('/').map(encodeURIComponent).join('/')}?Authorization=${authorizationToken}`;
		}
	};
}
