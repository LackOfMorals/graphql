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

import { Neo4jGraphQLSchemaValidationError } from "../classes";

import type { Annotation, Annotations } from "./annotation/Annotation";
import { annotationToKey } from "./annotation/Annotation";
import type { Attribute } from "./attribute/Attribute";
// import type { Field } from "./attribute/Field";

export class Operation {
    public readonly name: string;
    //  only includes custom Cypher fields
    public readonly attributes: Map<string, Attribute> = new Map();
    public readonly annotations: Partial<Annotations> = {};

    constructor({
        name,
        attributes = [],
        annotations = [],
    }: {
        name: string;
        attributes?: Attribute[];
        annotations?: Annotation[];
    }) {
        this.name = name;

        for (const attribute of attributes) {
            this.addAttribute(attribute);
        }

        for (const annotation of annotations) {
            this.addAnnotation(annotation);
        }
    }

    public findAttribute(name: string): Attribute | undefined {
        return this.attributes.get(name);
    }

    private addAttribute(attribute: Attribute): void {
        if (this.attributes.has(attribute.name)) {
            throw new Neo4jGraphQLSchemaValidationError(`Attribute ${attribute.name} already exists in ${this.name}`);
        }
        this.attributes.set(attribute.name, attribute);
    }

    private addAnnotation(annotation: Annotation): void {
        const annotationKey = annotationToKey(annotation);
        const existingAnnotation = this.annotations[annotationKey];

        if (existingAnnotation) {
            throw new Neo4jGraphQLSchemaValidationError(`Annotation ${annotationKey} already exists in ${this.name}`);
        }

        // We cast to any because we aren't narrowing the Annotation type here.
        this.annotations[annotationKey] = annotation as any;
    }
}
