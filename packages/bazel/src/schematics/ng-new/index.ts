/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 *
 * @fileoverview Schematics for ng-new project that builds with Bazel.
 */

import {SchematicContext, apply, applyTemplates, chain, externalSchematic, MergeStrategy, mergeWith, move, Rule, schematic, Tree, url, SchematicsException, UpdateRecorder,} from '@angular-devkit/schematics';
import {parseJsonAst, JsonAstObject, strings, JsonValue} from '@angular-devkit/core';
import {findPropertyInAstObject, insertPropertyInAstObjectInOrder} from '@schematics/angular/utility/json-utils';
import {validateProjectName} from '@schematics/angular/utility/validation';
import {getWorkspace} from '@schematics/angular/utility/config';
import {Schema} from './schema';

function addDevDependenciesToPackageJson(options: Schema) {
  return (host: Tree) => {
    const packageJson = `${options.name}/package.json`;

    if (!host.exists(packageJson)) {
      throw new Error(`Could not find ${packageJson}`);
    }
    const packageJsonContent = host.read(packageJson);
    if (!packageJsonContent) {
      throw new Error('Failed to read package.json content');
    }
    const jsonAst = parseJsonAst(packageJsonContent.toString()) as JsonAstObject;
    const deps = findPropertyInAstObject(jsonAst, 'dependencies') as JsonAstObject;
    const devDeps = findPropertyInAstObject(jsonAst, 'devDependencies') as JsonAstObject;

    const angularCoreNode = findPropertyInAstObject(deps, '@angular/core');
    const angularCoreVersion = angularCoreNode !.value as string;

    const devDependencies: {[k: string]: string} = {
      '@angular/bazel': angularCoreVersion,
      // TODO(kyliau): Consider moving this to latest-versions.ts
      '@bazel/bazel': '^0.21.0',
      '@bazel/karma': '^0.22.0',
      '@bazel/typescript': '^0.22.0',
    };

    const recorder = host.beginUpdate(packageJson);
    for (const packageName of Object.keys(devDependencies)) {
      const version = devDependencies[packageName];
      const indent = 4;
      insertPropertyInAstObjectInOrder(recorder, devDeps, packageName, version, indent);
    }
    host.commitUpdate(recorder);
    return host;
  };
}

function overwriteMainAndIndex(options: Schema) {
  return (host: Tree) => {
    let newProjectRoot = '';
    try {
      const workspace = getWorkspace(host);
      newProjectRoot = workspace.newProjectRoot || '';
    } catch {
    }
    const srcDir = `${newProjectRoot}/${options.name}/src`;

    return mergeWith(
        apply(
            url('./files'),
            [
              applyTemplates({
                utils: strings,
                ...options,
                'dot': '.',
              }),
              move(srcDir),
            ]),
        MergeStrategy.Overwrite);
  };
}

function replacePropertyInAstObject(
    recorder: UpdateRecorder, node: JsonAstObject, propertyName: string, value: JsonValue,
    indent: number) {
  const property = findPropertyInAstObject(node, propertyName);
  if (property === null) {
    throw new Error(`Property ${propertyName} does not exist in JSON object`);
  }
  const {start, text} = property;
  recorder.remove(start.offset, text.length);
  const indentStr = '\n' +
      ' '.repeat(indent);
  const content = JSON.stringify(value, null, '  ').replace(/\n/g, indentStr);
  recorder.insertLeft(start.offset, content);
}

function updateWorkspaceFileToUseBazelBuilder(options: Schema): Rule {
  return (host: Tree, context: SchematicContext) => {
    const {name} = options;
    const workspacePath = `${name}/angular.json`;
    if (!host.exists(workspacePath)) {
      throw new SchematicsException(`Workspace file ${workspacePath} not found.`);
    }
    const workspaceBuffer = host.read(workspacePath) !;
    const workspaceJsonAst = parseJsonAst(workspaceBuffer.toString()) as JsonAstObject;
    const projects = findPropertyInAstObject(workspaceJsonAst, 'projects');
    if (!projects) {
      throw new SchematicsException('Expect projects in angular.json to be an Object');
    }
    const project = findPropertyInAstObject(projects as JsonAstObject, name);
    if (!project) {
      throw new SchematicsException(`Expected projects to contain ${name}`);
    }
    const recorder = host.beginUpdate(workspacePath);
    const indent = 6;
    replacePropertyInAstObject(
        recorder, project as JsonAstObject, 'architect', {
          'build': {
            'builder': '@angular/bazel:build',
            'options': {'targetLabel': '//src:bundle.js', 'bazelCommand': 'build'},
            'configurations': {'production': {'targetLabel': '//src:bundle'}}
          },
          'serve': {
            'builder': '@angular/bazel:build',
            'options': {'targetLabel': '//src:devserver', 'bazelCommand': 'run'},
            'configurations': {'production': {'targetLabel': '//src:prodserver'}}
          },
          'extract-i18n': {
            'builder': '@angular-devkit/build-angular:extract-i18n',
            'options': {'browserTarget': `${name}:build`}
          },
          'test': {
            'builder': '@angular/bazel:build',
            'options': {'bazelCommand': 'test', 'targetLabel': '//src/...'}
          },
          'lint': {
            'builder': '@angular-devkit/build-angular:tslint',
            'options': {
              'tsConfig': ['src/tsconfig.app.json', 'src/tsconfig.spec.json'],
              'exclude': ['**/node_modules/**']
            }
          }
        },
        indent);

    const e2e = `${options.name}-e2e`;
    const e2eNode = findPropertyInAstObject(projects as JsonAstObject, e2e);
    if (e2eNode) {
      replacePropertyInAstObject(
          recorder, e2eNode as JsonAstObject, 'architect', {
            'e2e': {
              'builder': '@angular/bazel:build',
              'options': {'bazelCommand': 'test', 'targetLabel': '//e2e:devserver_test'},
              'configurations': {'production': {'targetLabel': '//e2e:prodserver_test'}}
            },
            'lint': {
              'builder': '@angular-devkit/build-angular:tslint',
              'options': {'tsConfig': 'e2e/tsconfig.e2e.json', 'exclude': ['**/node_modules/**']}
            }
          },
          indent);
    }

    host.commitUpdate(recorder);
    return host;
  };
}

export default function(options: Schema): Rule {
  return (host: Tree) => {
    validateProjectName(options.name);

    return chain([
      externalSchematic('@schematics/angular', 'ng-new', {
        ...options,
        skipInstall: true,
      }),
      addDevDependenciesToPackageJson(options),
      schematic('bazel-workspace', options),
      overwriteMainAndIndex(options),
      updateWorkspaceFileToUseBazelBuilder(options),
    ]);
  };
}
