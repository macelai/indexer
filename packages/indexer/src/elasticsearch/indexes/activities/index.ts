/* eslint-disable @typescript-eslint/no-explicit-any */

import { elasticsearch } from "@/common/elasticsearch";

import {
  AggregationsAggregate,
  QueryDslQueryContainer,
  SearchResponse,
  Sort,
} from "@elastic/elasticsearch/lib/api/types";

import { SortResults } from "@elastic/elasticsearch/lib/api/typesWithBodyKey";
import { logger } from "@/common/logger";
import { CollectionsEntity } from "@/models/collections/collections-entity";
import {
  ActivityDocument,
  ActivityType,
  CollectionAggregation,
} from "@/elasticsearch/indexes/activities/base";
import { getNetworkName, getNetworkSettings } from "@/config/network";
import _ from "lodash";
import { buildContinuation, splitContinuation } from "@/common/utils";
import { backfillActivitiesElasticsearchJob } from "@/jobs/activities/backfill/backfill-activities-elasticsearch-job";

import * as CONFIG from "@/elasticsearch/indexes/activities/config";

const INDEX_NAME = `${getNetworkName()}.activities`;

export const save = async (
  activities: ActivityDocument[],
  upsert = true,
  overrideIndexedAt = true
): Promise<void> => {
  try {
    if (overrideIndexedAt) {
      activities.forEach((activity) => {
        activity.indexedAt = new Date();
      });
    }

    const response = await elasticsearch.bulk({
      body: activities.flatMap((activity) => [
        { [upsert ? "index" : "create"]: { _index: INDEX_NAME, _id: activity.id } },
        activity,
      ]),
    });

    if (response.errors) {
      if (upsert) {
        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            message: "save activities errors",
            topic: "save",
            upsert,
            response,
          })
        );
      }
    }
  } catch (error) {
    logger.error(
      "elasticsearch-activities",
      JSON.stringify({
        message: `error saving activities. error=${error}`,
        topic: "save",
        upsert,
        error,
      })
    );

    throw error;
  }
};

export const getChainStatsFromActivity = async () => {
  const now = Date.now();

  // rounds to 5 minute intervals to take advantage of caching
  const oneDayAgo =
    (Math.floor((now - 24 * 60 * 60 * 1000) / (5 * 60 * 1000)) * (5 * 60 * 1000)) / 1000;
  const sevenDaysAgo =
    (Math.floor((now - 7 * 24 * 60 * 60 * 1000) / (5 * 60 * 1000)) * (5 * 60 * 1000)) / 1000;

  const periods = [
    {
      name: "1day",
      startTime: oneDayAgo,
    },
    {
      name: "7day",
      startTime: sevenDaysAgo,
    },
  ];

  const queries = periods.map(
    (period) =>
      ({
        name: period.name,
        body: {
          query: {
            constant_score: {
              filter: {
                bool: {
                  filter: [
                    {
                      terms: {
                        type: ["sale", "mint"],
                      },
                    },
                    {
                      range: {
                        timestamp: {
                          gte: period.startTime,
                          format: "epoch_second",
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          aggs: {
            sales_by_type: {
              terms: {
                field: "type",
              },
              aggs: {
                sales_count: {
                  value_count: {
                    field: "id",
                  },
                },
                total_volume: {
                  sum: { field: "pricing.priceDecimal" },
                },
              },
            },
          },
          size: 0,
        },
      } as any)
  );

  // fetch time periods in parallel
  const results = (await Promise.all(
    queries.map((query) => {
      return elasticsearch
        .search({
          index: INDEX_NAME,
          body: query.body,
        })
        .then((result) => ({ name: query.name, result }));
    })
  )) as any;

  return results.reduce((stats: any, result: any) => {
    const buckets = result?.result?.aggregations?.sales_by_type?.buckets as any;
    const mints = buckets.find((bucket: any) => bucket.key == "mint");
    const sales = buckets.find((bucket: any) => bucket.key == "sale");

    const mintCount = mints?.sales_count?.value || 0;
    const saleCount = sales?.sales_count?.value || 0;
    const mintVolume = mints?.total_volume?.value || 0;
    const saleVolume = sales?.total_volume?.value || 0;

    return {
      ...stats,
      [result.name]: {
        mintCount,
        saleCount,
        totalCount: mintCount + saleCount,
        mintVolume: _.round(mintVolume, 2),
        saleVolume: _.round(saleVolume, 2),
        totalVolume: _.round(mintVolume + saleVolume, 2),
      },
    };
  }, {});
};

export enum TopSellingFillOptions {
  sale = "sale",
  mint = "mint",
  any = "any",
}

const mapBucketToCollection = (bucket: any, includeRecentSales: boolean) => {
  const data = bucket?.top_collection_hits?.hits?.hits[0]?._source;
  const collectionData = data.collection;

  const recentSales = bucket?.top_collection_hits?.hits?.hits.map((hit: any) => {
    const sale = hit._source;

    return {
      contract: sale.contract,
      token: sale.token,
      collection: sale.collection,
      toAddress: sale.toAddress,
      type: sale.type,
      timestamp: sale.timestamp,
      pricing: sale.pricing,
    };
  });

  return {
    volume: bucket?.total_volume?.value,
    count: bucket?.total_sales.value,
    id: collectionData?.id,
    name: collectionData?.name,
    image: collectionData?.image,
    primaryContract: data?.contract,
    recentSales: includeRecentSales ? recentSales : [],
  };
};

export const getTopSellingCollections = async (params: {
  startTime: number;
  endTime?: number;
  fillType: TopSellingFillOptions;
  sortBy?: "volume" | "sales";
  limit: number;
  includeRecentSales: boolean;
}): Promise<CollectionAggregation[]> => {
  const { startTime, endTime, fillType, limit, sortBy } = params;

  const { trendingExcludedContracts } = getNetworkSettings();

  const salesQuery = {
    bool: {
      filter: [
        {
          terms: {
            type: fillType == "any" ? ["sale", "mint"] : [fillType],
          },
        },
        {
          range: {
            timestamp: {
              gte: startTime,
              ...(endTime ? { lte: endTime } : {}),
              format: "epoch_second",
            },
          },
        },
      ],
      ...(trendingExcludedContracts && {
        must_not: [
          {
            terms: {
              "collection.id": trendingExcludedContracts,
            },
          },
        ],
      }),
    },
  } as any;

  const sort = sortBy == "volume" ? { total_volume: "desc" } : { total_transactions: "desc" };
  const collectionAggregation = {
    collections: {
      terms: {
        field: "collection.id",
        size: limit,
        order: sort,
      },
      aggs: {
        total_sales: {
          value_count: {
            field: "id",
          },
        },
        total_transactions: {
          cardinality: {
            field: "event.txHash",
          },
        },
        total_volume: {
          sum: {
            field: "pricing.priceDecimal",
          },
        },

        top_collection_hits: {
          top_hits: {
            _source: {
              includes: [
                "contract",
                "collection.name",
                "collection.image",
                "collection.id",
                "name",
                "toAddress",
                "token.id",
                "token.name",
                "token.image",
                "type",
                "timestamp",
                "pricing.price",
                "pricing.priceDecimal",
                "pricing.currencyPrice",
                "pricing.usdPrice",
                "pricing.feeBps",
                "pricing.currency",
                "pricing.value",
                "pricing.valueDecimal",
                "pricing.currencyValue",
                "pricing.normalizedValue",
                "pricing.normalizedValueDecimal",
                "pricing.currencyNormalizedValue",
              ],
            },
            size: params.includeRecentSales ? 8 : 1,

            ...(params.includeRecentSales && {
              sort: [
                {
                  timestamp: {
                    order: "desc",
                  },
                },
              ],
            }),
          },
        },
      },
    },
  } as any;

  const esResult = (await elasticsearch.search({
    index: INDEX_NAME,
    size: 0,
    body: {
      query: salesQuery,
      aggs: collectionAggregation,
    },
  })) as any;

  return esResult?.aggregations?.collections?.buckets?.map((bucket: any) =>
    mapBucketToCollection(bucket, params.includeRecentSales)
  );
};

export const deleteActivitiesById = async (ids: string[]): Promise<void> => {
  try {
    const response = await elasticsearch.bulk({
      body: ids.flatMap((id) => ({ delete: { _index: INDEX_NAME, _id: id } })),
    });

    if (response.errors) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "delete-by-id-conflicts",
          data: {
            ids: JSON.stringify(ids),
          },
          response,
        })
      );
    }
  } catch (error) {
    logger.error(
      "elasticsearch-activities",
      JSON.stringify({
        topic: "delete-by-id-error",
        data: {
          ids: JSON.stringify(ids),
        },
        error,
      })
    );

    throw error;
  }
};

export const search = async (
  params: {
    types?: ActivityType[];
    tokens?: { contract: string; tokenId: string }[];
    contracts?: string[];
    collections?: string[];
    sources?: number[];
    users?: string[];
    startTimestamp?: number;
    endTimestamp?: number;
    sortBy?: "timestamp" | "createdAt";
    limit?: number;
    continuation?: string | null;
    continuationAsInt?: boolean;
  },
  debug = false
): Promise<{ activities: ActivityDocument[]; continuation: string | null }> => {
  const esQuery = {};

  (esQuery as any).bool = { filter: [] };

  if (params.types?.length) {
    (esQuery as any).bool.filter.push({ terms: { type: params.types } });
  }

  if (params.collections?.length) {
    const collections = params.collections.map((collection) => collection.toLowerCase());

    (esQuery as any).bool.filter.push({
      terms: { "collection.id": collections },
    });
  }

  if (params.contracts?.length) {
    const contracts = params.contracts.map((contract) => contract.toLowerCase());

    (esQuery as any).bool.filter.push({
      terms: { contract: contracts },
    });
  }

  if (params.sources?.length) {
    (esQuery as any).bool.filter.push({
      terms: { "order.sourceId": params.sources },
    });
  }

  if (params.tokens?.length) {
    if (params.contracts?.length === 1) {
      (esQuery as any).bool.filter.push({
        terms: { "token.id": params.tokens.map((token) => token.tokenId) },
      });
    } else {
      const tokensFilter = { bool: { should: [] } };

      for (const token of params.tokens) {
        const contract = token.contract.toLowerCase();
        const tokenId = token.tokenId;

        (tokensFilter as any).bool.should.push({
          bool: {
            must: [
              {
                term: { contract },
              },
              {
                term: { ["token.id"]: tokenId },
              },
            ],
          },
        });
      }

      (esQuery as any).bool.filter.push(tokensFilter);
    }
  }

  if (params.users?.length) {
    const users = params.users.map((user) => user.toLowerCase());

    const usersFilter = { bool: { should: [] } };

    (usersFilter as any).bool.should.push({
      terms: { fromAddress: users },
    });

    (usersFilter as any).bool.should.push({
      terms: { toAddress: users },
    });

    (esQuery as any).bool.filter.push(usersFilter);
  }

  if (params.startTimestamp) {
    (esQuery as any).bool.filter.push({
      range: { timestamp: { gte: params.startTimestamp, format: "epoch_second" } },
    });
  }

  if (params.endTimestamp) {
    (esQuery as any).bool.filter.push({
      range: { timestamp: { lt: params.endTimestamp, format: "epoch_second" } },
    });
  }

  let searchAfter: string[] = [];

  if (params.continuation) {
    if (params.continuationAsInt) {
      searchAfter = [params.continuation];
    } else {
      searchAfter = _.split(splitContinuation(params.continuation)[0], "_");
    }
  }

  const esSort: any[] = [];

  if (params.sortBy == "timestamp") {
    esSort.push({ timestamp: { order: "desc", format: "epoch_second" } });
  } else {
    esSort.push({ createdAt: { order: "desc" } });
  }

  // Backward compatibility
  if (searchAfter?.length != 1 && !params.continuationAsInt) {
    esSort.push({ id: { order: "desc" } });
  }

  try {
    const esResult = await _search(
      {
        query: esQuery,
        sort: esSort as Sort,
        size: params.limit,
        search_after: searchAfter?.length ? searchAfter : undefined,
      },
      0,
      debug
    );

    const activities: ActivityDocument[] = esResult.hits.hits.map((hit) => hit._source!);

    let continuation = null;

    if (esResult.hits.hits.length === params.limit) {
      const lastResult = _.last(esResult.hits.hits);

      if (lastResult) {
        const lastResultSortValue = lastResult.sort!.join("_");

        if (params.continuationAsInt) {
          continuation = `${lastResultSortValue}`;
        } else {
          continuation = buildContinuation(`${lastResultSortValue}`);
        }
      }
    }

    return { activities, continuation };
  } catch (error) {
    logger.error(
      "elasticsearch-activities",
      JSON.stringify({
        topic: "search",
        data: {
          params: params,
        },
        error,
      })
    );

    throw error;
  }
};

export const _search = async (
  params: {
    _source?: string[] | undefined;
    query?: QueryDslQueryContainer | undefined;
    sort?: Sort | undefined;
    size?: number | undefined;
    search_after?: SortResults | undefined;
    track_total_hits?: boolean;
  },
  retries = 0,
  debug = false
): Promise<SearchResponse<ActivityDocument, Record<string, AggregationsAggregate>>> => {
  try {
    params.track_total_hits = params.track_total_hits ?? false;

    const esResult = await elasticsearch.search<ActivityDocument>({
      index: INDEX_NAME,
      ...params,
    });

    if (retries > 0 || debug) {
      logger.info(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "_search",
          latency: esResult.took,
          paramsJSON: JSON.stringify(params),
          retries,
          esResult: debug ? esResult : undefined,
          params: debug ? params : undefined,
        })
      );
    }

    return esResult;
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "_search",
          message: "Retrying...",
          data: {
            params: JSON.stringify(params),
          },
          error,
          retries,
        })
      );

      if (retries <= 3) {
        retries += 1;
        return _search(params, retries, debug);
      }

      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "_search",
          message: "Max retries reached.",
          data: {
            params: JSON.stringify(params),
          },
          error,
          retries,
        })
      );

      throw new Error("Could not perform search.");
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "_search",
          message: "Unexpected error.",
          data: {
            params: JSON.stringify(params),
          },
          error,
          retries,
        })
      );
    }

    throw error;
  }
};

export const getIndexName = (): string => {
  return INDEX_NAME;
};

export const initIndex = async (): Promise<void> => {
  try {
    const indexConfigName =
      getNetworkSettings().elasticsearch?.indexes?.activities?.configName ?? "CONFIG_DEFAULT";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const indexConfig = CONFIG[indexConfigName];

    if (await elasticsearch.indices.exists({ index: INDEX_NAME })) {
      logger.info(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "initIndex",
          message: "Index already exists.",
          indexName: INDEX_NAME,
          indexConfig,
          indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
        })
      );

      if (getNetworkSettings().elasticsearch?.indexes?.activities?.disableMappingsUpdate) {
        logger.info(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "initIndex",
            message: "Mappings update disabled.",
            indexName: INDEX_NAME,
            indexConfig,
            indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
          })
        );

        return;
      }

      const getIndexResponse = await elasticsearch.indices.get({ index: INDEX_NAME });

      const indexName = Object.keys(getIndexResponse)[0];

      const putMappingResponse = await elasticsearch.indices.putMapping({
        index: indexName,
        properties: indexConfig.mappings.properties,
      });

      logger.info(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "initIndex",
          message: "Updated mappings.",
          indexName: INDEX_NAME,
          indexConfig,
          indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
          putMappingResponse,
        })
      );
    } else {
      logger.info(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "initIndex",
          message: "Creating Index.",
          indexName: INDEX_NAME,
          indexConfig,
          indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
        })
      );

      const params = {
        aliases: {
          [INDEX_NAME]: {},
        },
        index: `${INDEX_NAME}-${Date.now()}`,
        ...indexConfig,
      };

      const createIndexResponse = await elasticsearch.indices.create(params);

      logger.info(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "initIndex",
          message: "Index Created!",
          indexName: INDEX_NAME,
          indexConfig,
          indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
          params,
          createIndexResponse,
        })
      );

      await backfillActivitiesElasticsearchJob.addToQueue();
    }
  } catch (error) {
    logger.error(
      "elasticsearch-activities",
      JSON.stringify({
        topic: "initIndex",
        message: "Error.",
        indexName: INDEX_NAME,
        indexSettings: getNetworkSettings().elasticsearch?.indexes?.activities,
        error,
      })
    );

    throw error;
  }
};

export const updateActivitiesMissingCollection = async (
  contract: string,
  tokenId: number,
  collection: CollectionsEntity
): Promise<boolean> => {
  let keepGoing = false;

  const query = {
    bool: {
      must_not: [
        {
          exists: {
            field: "collection.id",
          },
        },
      ],
      must: [
        {
          term: {
            contract: contract.toLowerCase(),
          },
        },
        {
          term: {
            "token.id": tokenId,
          },
        },
      ],
    },
  };

  try {
    const esResult = await _search({
      _source: ["id"],
      // This is needed due to issue with elasticsearch DSL.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      query,
      size: 1000,
    });

    const pendingUpdateActivities: string[] = esResult.hits.hits.map((hit) => hit._source!.id);

    if (pendingUpdateActivities.length) {
      const bulkParams = {
        body: pendingUpdateActivities.flatMap((activityId) => [
          { update: { _index: INDEX_NAME, _id: activityId, retry_on_conflict: 3 } },
          {
            script: {
              source:
                "ctx._source.collection = [:]; ctx._source.collection.id = params.collection_id; ctx._source.collection.name = params.collection_name; ctx._source.collection.image = params.collection_image;",
              params: {
                collection_id: collection.id,
                collection_name: collection.name,
                collection_image: collection.metadata?.imageUrl,
              },
            },
          },
        ]),
        filter_path: "items.*.error",
      };

      const response = await elasticsearch.bulk(bulkParams, { ignore: [404] });

      if (response?.errors) {
        keepGoing = response?.items.some((item) => item.update?.status !== 400);

        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "updateActivitiesMissingCollection",
            message: `Errors in response`,
            data: {
              contract,
              tokenId,
              collection,
            },
            bulkParams,
            response,
            keepGoing,
          })
        );
      } else {
        keepGoing = pendingUpdateActivities.length === 1000;

        // logger.info(
        //   "elasticsearch-activities",
        //   JSON.stringify({
        //     topic: "updateActivitiesMissingCollection",
        //     message: `Success`,
        //     data: {
        //       contract,
        //       tokenId,
        //       collection,
        //     },
        //     bulkParams,
        //     response,
        //     keepGoing,
        //   })
        // );
      }
    }
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesMissingCollection",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            collection,
          },
          error,
        })
      );

      keepGoing = true;
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesMissingCollection",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            collection,
          },
          error,
        })
      );

      throw error;
    }
  }

  return keepGoing;
};

export const updateActivitiesCollection = async (
  contract: string,
  tokenId: string,
  newCollection: CollectionsEntity,
  oldCollectionId: string
): Promise<boolean> => {
  let keepGoing = false;

  const query = {
    bool: {
      must_not: [
        {
          term: {
            "collection.id": newCollection.id,
          },
        },
      ],
      must: [
        {
          term: {
            contract: contract.toLowerCase(),
          },
        },
        {
          term: {
            "token.id": tokenId,
          },
        },
      ],
    },
  };

  try {
    const esResult = await _search(
      {
        _source: ["id"],
        // This is needed due to issue with elasticsearch DSL.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        query,
        size: 1000,
      },
      0,
      true
    );

    const pendingUpdateDocuments: { id: string; index: string }[] = esResult.hits.hits.map(
      (hit) => ({ id: hit._source!.id, index: hit._index })
    );

    if (pendingUpdateDocuments.length) {
      const bulkParams = {
        body: pendingUpdateDocuments.flatMap((document) => [
          { update: { _index: document.index, _id: document.id, retry_on_conflict: 3 } },
          {
            script: {
              source:
                "ctx._source.collection = [:]; ctx._source.collection.id = params.collection_id; ctx._source.collection.name = params.collection_name; ctx._source.collection.image = params.collection_image;",
              params: {
                collection_id: newCollection.id,
                collection_name: newCollection.name,
                collection_image: newCollection.metadata?.imageUrl,
              },
            },
          },
        ]),
        filter_path: "items.*.error",
      };

      const response = await elasticsearch.bulk(bulkParams, { ignore: [404] });

      if (response?.errors) {
        keepGoing = response?.items.some((item) => item.update?.status !== 400);

        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "updateActivitiesCollection",
            message: `Errors in response`,
            data: {
              contract,
              tokenId,
              newCollection,
              oldCollectionId,
            },
            bulkParams,
            response,
          })
        );
      } else {
        keepGoing = pendingUpdateDocuments.length === 1000;

        // logger.info(
        //   "elasticsearch-activities",
        //   JSON.stringify({
        //     topic: "updateActivitiesCollection",
        //     message: `Success`,
        //     data: {
        //       contract,
        //       tokenId,
        //       newCollection,
        //       oldCollectionId,
        //     },
        //     bulkParams,
        //     response,
        //     keepGoing,
        //   })
        // );
      }
    }
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesCollection",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            newCollection,
            oldCollectionId,
          },
          error,
        })
      );

      keepGoing = true;
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesCollection",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            newCollection,
            oldCollectionId,
          },
          error,
        })
      );

      throw error;
    }
  }

  return keepGoing;
};

export const updateActivitiesTokenMetadata = async (
  contract: string,
  tokenId: string,
  tokenData: { name: string | null; image: string | null; media: string | null }
): Promise<boolean> => {
  let keepGoing = false;

  const should: any[] = [
    {
      bool: tokenData.name
        ? {
            must_not: [
              {
                term: {
                  "token.name": tokenData.name,
                },
              },
            ],
          }
        : {
            must: [
              {
                exists: {
                  field: "token.name",
                },
              },
            ],
          },
    },
    {
      bool: tokenData.image
        ? {
            must_not: [
              {
                term: {
                  "token.image": tokenData.image,
                },
              },
            ],
          }
        : {
            must: [
              {
                exists: {
                  field: "token.image",
                },
              },
            ],
          },
    },
    {
      bool: tokenData.media
        ? {
            must_not: [
              {
                term: {
                  "token.media": tokenData.media,
                },
              },
            ],
          }
        : {
            must: [
              {
                exists: {
                  field: "token.media",
                },
              },
            ],
          },
    },
  ];

  const query = {
    bool: {
      filter: {
        bool: {
          must: [
            {
              term: {
                contract: "0xb76fbbb30e31f2c3bdaa2466cfb1cfe39b220d06",
              },
            },
            {
              term: {
                "token.id": "7514",
              },
            },
          ],
          must_not: [
            {
              term: {
                type: "bid",
              },
            },
          ],
          should,
        },
      },
    },
  };

  try {
    const esResult = await _search(
      {
        _source: ["id"],
        // This is needed due to issue with elasticsearch DSL.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        query,
        size: 1000,
      },
      0
    );

    const pendingUpdateDocuments: { id: string; index: string }[] = esResult.hits.hits.map(
      (hit) => ({ id: hit._source!.id, index: hit._index })
    );

    if (pendingUpdateDocuments.length) {
      const bulkParams = {
        body: pendingUpdateDocuments.flatMap((document) => [
          { update: { _index: document.index, _id: document.id, retry_on_conflict: 3 } },
          {
            script: {
              source:
                "if (params.token_name == null) { ctx._source.token.remove('name') } else { ctx._source.token.name = params.token_name } if (params.token_image == null) { ctx._source.token.remove('image') } else { ctx._source.token.image = params.token_image } if (params.token_media == null) { ctx._source.token.remove('media') } else { ctx._source.token.media = params.token_media }",
              params: {
                token_name: tokenData.name ?? null,
                token_image: tokenData.image ?? null,
                token_media: tokenData.media ?? null,
              },
            },
          },
        ]),
        filter_path: "items.*.error",
      };

      const response = await elasticsearch.bulk(bulkParams, { ignore: [404] });

      if (response?.errors) {
        keepGoing = response?.items.some((item) => item.update?.status !== 400);

        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "updateActivitiesTokenMetadata",
            message: `Errors in response`,
            data: {
              contract,
              tokenId,
              tokenData,
            },
            bulkParams,
            response,
          })
        );
      } else {
        keepGoing = pendingUpdateDocuments.length === 1000;

        // logger.info(
        //   "elasticsearch-activities",
        //   JSON.stringify({
        //     topic: "updateActivitiesTokenMetadata",
        //     message: `Success`,
        //     data: {
        //       contract,
        //       tokenId,
        //       tokenData,
        //     },
        //     bulkParams,
        //     response,
        //     keepGoing,
        //   })
        // );
      }
    }
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesTokenMetadata",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            tokenData,
          },
          error,
        })
      );

      keepGoing = true;
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesTokenMetadata",
          message: `Unexpected error`,
          data: {
            contract,
            tokenId,
            tokenData,
          },
          error,
        })
      );

      throw error;
    }
  }

  return keepGoing;
};

export const updateActivitiesCollectionMetadata = async (
  collectionId: string,
  collectionData: { name: string | null; image: string | null }
): Promise<boolean> => {
  let keepGoing = false;

  const should: any[] = [
    {
      bool: collectionData.name
        ? {
            must_not: [
              {
                term: {
                  "collection.name": collectionData.name,
                },
              },
            ],
          }
        : {
            must: [
              {
                exists: {
                  field: "collection.name",
                },
              },
            ],
          },
    },
    {
      bool: collectionData.image
        ? {
            must_not: [
              {
                term: {
                  "collection.image": collectionData.image,
                },
              },
            ],
          }
        : {
            must: [
              {
                exists: {
                  field: "collection.image",
                },
              },
            ],
          },
    },
  ];

  const query = {
    bool: {
      must: [
        {
          term: {
            "collection.id": collectionId.toLowerCase(),
          },
        },
      ],
      filter: {
        bool: {
          should,
        },
      },
    },
  };

  try {
    const esResult = await _search(
      {
        _source: ["id"],
        // This is needed due to issue with elasticsearch DSL.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        query,
        size: 1000,
      },
      0,
      true
    );

    const pendingUpdateDocuments: { id: string; index: string }[] = esResult.hits.hits.map(
      (hit) => ({ id: hit._source!.id, index: hit._index })
    );

    if (pendingUpdateDocuments.length) {
      const bulkParams = {
        body: pendingUpdateDocuments.flatMap((document) => [
          { update: { _index: document.index, _id: document.id, retry_on_conflict: 3 } },
          {
            script: {
              source:
                "if (params.collection_name == null) { ctx._source.collection.remove('name') } else { ctx._source.collection.name = params.collection_name } if (params.collection_image == null) { ctx._source.collection.remove('image') } else { ctx._source.collection.image = params.collection_image }",
              params: {
                collection_name: collectionData.name ?? null,
                collection_image: collectionData.image ?? null,
              },
            },
          },
        ]),
        filter_path: "items.*.error",
      };

      const response = await elasticsearch.bulk(bulkParams, { ignore: [404] });

      if (response?.errors) {
        keepGoing = response?.items.some((item) => item.update?.status !== 400);

        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "updateActivitiesCollectionMetadata",
            message: `Errors in response. collectionId=${collectionId}, collectionData=${JSON.stringify(
              collectionData
            )}`,
            data: {
              collectionId,
              collectionData,
            },
            bulkParams: JSON.stringify(bulkParams),
            response,
            keepGoing,
            queryJson: JSON.stringify(query),
          })
        );
      } else {
        keepGoing = pendingUpdateDocuments.length === 1000;

        logger.info(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "updateActivitiesCollectionMetadata",
            message: `Success. collectionId=${collectionId}, collectionData=${JSON.stringify(
              collectionData
            )}`,
            data: {
              collectionId,
              collectionData,
            },
            bulkParams: JSON.stringify(bulkParams),
            response,
            keepGoing,
            queryJson: JSON.stringify(query),
          })
        );
      }
    }
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesCollectionMetadata",
          message: `Unexpected error`,
          data: {
            collectionId,
            collectionData,
          },
          error,
        })
      );

      keepGoing = true;
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "updateActivitiesCollectionMetadata",
          message: `Unexpected error`,
          data: {
            collectionId,
            collectionData,
          },
          error,
        })
      );

      throw error;
    }
  }

  return keepGoing;
};

export const deleteActivitiesByBlockHash = async (blockHash: string): Promise<boolean> => {
  let keepGoing = false;

  const query = {
    bool: {
      must: [
        {
          term: {
            "event.blockHash": blockHash,
          },
        },
      ],
    },
  };

  try {
    const esResult = await _search({
      _source: ["id"],
      // This is needed due to issue with elasticsearch DSL.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      query,
      size: 1000,
    });

    const pendingUpdateDocuments: { id: string; index: string }[] = esResult.hits.hits.map(
      (hit) => ({ id: hit._source!.id, index: hit._index })
    );

    if (pendingUpdateDocuments.length) {
      const bulkParams = {
        body: pendingUpdateDocuments.flatMap((document) => [
          { delete: { _index: document.index, _id: document.id } },
        ]),
        filter_path: "items.*.error",
      };

      const response = await elasticsearch.bulk(bulkParams, { ignore: [404] });

      if (response?.errors) {
        keepGoing = response?.items.some((item) => item.update?.status !== 400);

        logger.error(
          "elasticsearch-activities",
          JSON.stringify({
            topic: "deleteActivitiesByBlockHash",
            message: `Errors in response`,
            data: {
              blockHash,
            },
            bulkParams,
            response,
            keepGoing,
          })
        );
      } else {
        keepGoing = pendingUpdateDocuments.length === 1000;

        // logger.info(
        //   "elasticsearch-activities",
        //   JSON.stringify({
        //     topic: "deleteActivitiesByBlockHash",
        //     message: `Success`,
        //     data: {
        //       blockHash,
        //     },
        //     bulkParams,
        //     response,
        //     keepGoing,
        //   })
        // );
      }
    }
  } catch (error) {
    const retryableError =
      (error as any).meta?.meta?.aborted ||
      (error as any).meta?.body?.error?.caused_by?.type === "node_not_connected_exception";

    if (retryableError) {
      logger.warn(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "deleteActivitiesByBlockHash",
          message: `Unexpected error`,
          data: {
            blockHash,
          },
          error,
        })
      );

      keepGoing = true;
    } else {
      logger.error(
        "elasticsearch-activities",
        JSON.stringify({
          topic: "deleteActivitiesByBlockHash",
          message: `Unexpected error`,
          data: {
            blockHash,
          },
          error,
        })
      );

      throw error;
    }
  }

  return keepGoing;
};
