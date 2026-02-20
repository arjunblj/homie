export const MPP_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

export const normalizeHttpUrl = (value: string): string => {
  let url = value.trim().replace(/\/+$/u, '');
  if (url && !/^https?:\/\//iu.test(url)) {
    url = `http://${url}`;
  }
  return url;
};
