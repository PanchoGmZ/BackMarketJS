export function loadLocalEnvFile({ path = '.env.local', isCloud = process.env.APIFY_IS_AT_HOME === '1' } = {}) {
    if (isCloud) return false;
    try {
        process.loadEnvFile(path);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw new Error('LOCAL_ENV_FILE_INVALID');
    }
}
