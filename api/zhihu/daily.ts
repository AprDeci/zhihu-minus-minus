import axios from 'axios';
import type { ApiRequestOptions } from '../client';

export interface DailyStory {
  id: number;
  title: string;
  hint?: string;
  images?: string[];
}

export interface DailyPage {
  date?: string;
  stories?: DailyStory[];
}

export interface DailyDetail extends DailyStory {
  body?: string;
  image?: string;
  image_source?: string;
  share_url?: string;
}

const dailyClient = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'ZhihuDaily/2.9.0 (Android; 10; Scale/2.0)',
    Referer: 'https://daily.zhihu.com/',
  },
});

dailyClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    console.error('日报 API 请求失败', status ?? 'unknown');
    return Promise.reject(error);
  },
);

export const getDailyLatest = async (
  options: ApiRequestOptions = {},
): Promise<DailyPage> => {
  const res = await dailyClient.get<DailyPage>(
    'https://daily.zhihu.com/api/4/news/latest',
    { signal: options.signal },
  );
  return res.data;
};

export const getDailyBefore = async (
  date: string,
  options: ApiRequestOptions = {},
): Promise<DailyPage> => {
  const res = await dailyClient.get<DailyPage>(
    `https://daily.zhihu.com/api/4/news/before/${date}`,
    { signal: options.signal },
  );
  return res.data;
};

export const getDailyDetail = async (
  id: string | number,
  options: ApiRequestOptions = {},
): Promise<DailyDetail> => {
  const res = await dailyClient.get<DailyDetail>(
    `https://daily.zhihu.com/api/4/news/${id}`,
    {
      signal: options.signal,
    },
  );
  return res.data;
};
