import type {
  ZhihuActionResponse,
  ZhihuBestAnswerersResponse,
  ZhihuTopicDetail,
  ZhihuTopicFeedResponse,
  ZhihuTopicStructureResponse,
} from '@/types/zhihu';
import apiClient, { type ApiRequestOptions } from '../client';

export const TOPIC_INCLUDE =
  'introduction,questions_count,best_answers_count,followers_count,is_following,header_card';

export const getTopic = async (
  id: string | number,
): Promise<ZhihuTopicDetail> => {
  const res = await apiClient.get<ZhihuTopicDetail>(
    `/topics/${id}?include=${TOPIC_INCLUDE}`,
  );
  return res.data;
};

export const getTopicFeed = async (
  id: string | number,
  type: string = 'hot',
  offset: number = 0,
  options: ApiRequestOptions = {},
): Promise<ZhihuTopicFeedResponse> => {
  const typeMapping: Record<string, string> = {
    hot: 'hot',
    'top-answers': 'essence',
    unanswered: 'top_question',
  };
  const feedType = typeMapping[type] || type;
  const include =
    'data[*].target.content,voteup_count,comment_count,favlists_count,reaction,author.name,author.avatar_url,author.headline,author.is_following,relationship.voting,relationship.is_author,relationship.is_favorited,created_time,segment_infos';
  const res = await apiClient.get<ZhihuTopicFeedResponse>(
    `/topics/${id}/feeds/${feedType}?include=${include}&limit=20&offset=${offset}`,
    { signal: options.signal },
  );
  return res.data;
};

export const followTopic = async (
  id: string | number,
): Promise<ZhihuActionResponse> => {
  const res = await apiClient.post<ZhihuActionResponse>(
    `/topics/${id}/followers`,
  );
  return res.data;
};

export const unfollowTopic = async (
  id: string | number,
): Promise<ZhihuActionResponse> => {
  const res = await apiClient.delete<ZhihuActionResponse>(
    `/topics/${id}/followers`,
  );
  return res.data;
};

export const getTopicParents = async (
  id: string | number,
): Promise<ZhihuTopicStructureResponse> => {
  const res = await apiClient.get<ZhihuTopicStructureResponse>(
    `/topics/${id}/parent`,
  );
  return res.data;
};

export const getTopicChildren = async (
  id: string | number,
): Promise<ZhihuTopicStructureResponse> => {
  const res = await apiClient.get<ZhihuTopicStructureResponse>(
    `/topics/${id}/children`,
  );
  return res.data;
};

export const getBestAnswerers = async (
  id: string | number,
  limit: number = 3,
): Promise<ZhihuBestAnswerersResponse> => {
  const res = await apiClient.get<ZhihuBestAnswerersResponse>(
    `/topics/${id}/best_answerers?limit=${limit}`,
  );
  return res.data;
};
