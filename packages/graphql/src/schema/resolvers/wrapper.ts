/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from "debug";
import type { GraphQLFieldResolver, GraphQLResolveInfo } from "graphql";
import { print } from "graphql";
import type { Driver } from "neo4j-driver";
import { Neo4jError } from "neo4j-driver";
import type { Node, Relationship } from "../../classes";
import type { Neo4jDatabaseInfo } from "../../classes/Neo4jDatabaseInfo";
import { getNeo4jDatabaseInfo } from "../../classes/Neo4jDatabaseInfo";
import { Executor } from "../../classes/Executor";
import { AUTH_FORBIDDEN_ERROR, DEBUG_GRAPHQL } from "../../constants";
import type { AuthorizationContext, ContextFeatures, FulltextContext } from "../../types";
import type { SubscriptionConnectionContext, SubscriptionContext } from "./subscriptions/types";
import type { Neo4jGraphQLSchemaModel } from "../../schema-model/Neo4jGraphQLSchemaModel";
import Cypher from "@neo4j/cypher-builder";
import type { Neo4jGraphQLAuthorization } from "../../classes/authorization/Neo4jGraphQLAuthorization";
import type { Neo4jGraphQLContext } from "../../types/neo4j-graphql-context";

const debug = Debug(DEBUG_GRAPHQL);

export type WrapResolverArguments = {
    driver?: Driver;
    nodes: Node[];
    relationships: Relationship[];
    jwtPayloadFieldsMap?: Map<string, string>;
    schemaModel: Neo4jGraphQLSchemaModel;
    dbInfo?: Neo4jDatabaseInfo;
    features: ContextFeatures;
    authorization?: Neo4jGraphQLAuthorization;
};

/**
 * The type describing the context generated by {@link wrapResolver}.
 */
export interface Neo4jGraphQLComposedContext extends Neo4jGraphQLContext {
    /**
     * @deprecated The use of this field is now deprecated in favour of {@link schemaModel}.
     */
    nodes: Node[];
    /**
     * @deprecated The use of this field is now deprecated in favour of {@link schemaModel}.
     */
    relationships: Relationship[];
    schemaModel: Neo4jGraphQLSchemaModel;
    features: ContextFeatures;
    subscriptionsEnabled: boolean;
    executor: Executor;
    authorization: AuthorizationContext;
    neo4jDatabaseInfo?: Neo4jDatabaseInfo;
    fulltext?: FulltextContext;
}

let neo4jDatabaseInfo: Neo4jDatabaseInfo;

export const wrapResolver =
    ({
        driver,
        nodes,
        relationships,
        jwtPayloadFieldsMap,
        schemaModel,
        dbInfo,
        authorization,
        features,
    }: WrapResolverArguments) =>
    (next: GraphQLFieldResolver<any, Neo4jGraphQLComposedContext>) =>
    async (root, args, context: Neo4jGraphQLContext, info: GraphQLResolveInfo) => {
        if (debug.enabled) {
            const query = print(info.operation);

            debug(
                "%s",
                `Incoming GraphQL:\nQuery:\n${query}\nVariables:\n${JSON.stringify(info.variableValues, null, 2)}`
            );
        }

        if (!context?.executionContext) {
            if (!driver) {
                throw new Error(
                    "A Neo4j driver instance must either be passed to Neo4jGraphQL on construction, or a driver, session or transaction passed as context.executionContext in each request."
                );
            }
            context.executionContext = driver;
        }

        const subscriptionsEnabled = Boolean(features.subscriptions);

        const authorizationContext = await getAuthorizationContext(context, authorization, jwtPayloadFieldsMap);
        if (!context.jwt) {
            context.jwt = authorizationContext.jwt;
        }

        const executor = new Executor({
            executionContext: context.executionContext,
            cypherQueryOptions: context.cypherQueryOptions,
            sessionConfig: context.sessionConfig,
        });

        if (dbInfo) {
            neo4jDatabaseInfo = dbInfo;
        }
        if (!neo4jDatabaseInfo?.version) {
            neo4jDatabaseInfo = await getNeo4jDatabaseInfo(executor);
        }

        const internalContext = {
            nodes,
            relationships,
            schemaModel,
            features,
            subscriptionsEnabled,
            executor,
            neo4jDatabaseInfo,
            authorization: authorizationContext,
            // Consider anything in here overrides
            ...context,
        };

        return next(root, args, { ...context, ...internalContext }, info);
    };

export const wrapSubscription =
    (resolverArgs: WrapResolverArguments) =>
    (next) =>
    async (root: any, args: any, context: SubscriptionConnectionContext | undefined, info: GraphQLResolveInfo) => {
        const subscriptionsConfig = resolverArgs?.features.subscriptions;
        const schemaModel = resolverArgs?.schemaModel;
        const contextParams = context?.connectionParams || {};

        if (!subscriptionsConfig) {
            debug("Subscription Mechanism not set");
            return next(root, args, context, info);
        }

        const subscriptionContext: SubscriptionContext = {
            plugin: subscriptionsConfig,
            schemaModel,
        };

        if (context?.jwt) {
            subscriptionContext.jwt = context.jwt;
        } else {
            if (resolverArgs.authorization) {
                if (!contextParams.authorization && resolverArgs.authorization.globalAuthentication) {
                    throw new Neo4jError("Unauthenticated", AUTH_FORBIDDEN_ERROR);
                } else {
                    try {
                        const authorization = resolverArgs.authorization;
                        const jwt = await authorization.decodeBearerTokenWithVerify(contextParams.authorization);
                        subscriptionContext.jwt = jwt;
                        subscriptionContext.jwtPayloadFieldsMap = resolverArgs.jwtPayloadFieldsMap;
                    } catch (e) {
                        if (resolverArgs.authorization.globalAuthentication) {
                            throw e;
                        }
                        subscriptionContext.jwt = undefined;
                    }
                }
            }
        }

        return next(root, args, { ...context, ...contextParams, ...subscriptionContext }, info);
    };

async function getAuthorizationContext(
    context: Neo4jGraphQLContext,
    authorization?: Neo4jGraphQLAuthorization,
    jwtPayloadFieldsMap?: Map<string, string>
): Promise<AuthorizationContext> {
    if (!context.jwt) {
        if (authorization) {
            try {
                context.jwt = await authorization.decode(context);
                const isAuthenticated = true;
                return {
                    isAuthenticated,
                    jwt: context.jwt,
                    jwtParam: new Cypher.NamedParam("jwt", context.jwt),
                    isAuthenticatedParam: new Cypher.NamedParam("isAuthenticated", isAuthenticated),
                    claims: jwtPayloadFieldsMap,
                };
            } catch (e) {
                const isAuthenticated = false;
                return {
                    isAuthenticated,
                    jwtParam: new Cypher.NamedParam("jwt", {}),
                    isAuthenticatedParam: new Cypher.NamedParam("isAuthenticated", isAuthenticated),
                };
            }
        }
    }

    const isAuthenticated = true;
    const jwt = context.jwt;

    return {
        isAuthenticated,
        jwt,
        jwtParam: new Cypher.NamedParam("jwt", jwt),
        isAuthenticatedParam: new Cypher.NamedParam("isAuthenticated", isAuthenticated),
    };
}
