import * as path from 'path';
import fs from 'fs-extra';
import pMapSeries from 'p-map-series';
import { BitId } from '../../bit-id';
import { Consumer } from '..';
import ConsumerComponent from '../component';
import { COMPONENT_ORIGINS } from '../../constants';
import { pathNormalizeToLinux } from '../../utils/path';
import { PathOsBased } from '../../utils/path';
import Version from '../../scope/models/version';
import { SourceFile } from '../component/sources';
import { getMergeStrategyInteractive, FileStatus, MergeOptions, threeWayMerge } from './merge-version';
import { MergeStrategy, ApplyVersionResults, ApplyVersionResult, FailedComponents } from './merge-version';
import { MergeResultsThreeWay } from './merge-version/three-way-merge';
import GeneralError from '../../error/general-error';
import ManyComponentsWriter from '../component-ops/many-components-writer';
import { Tmp } from '../../scope/repositories';

export type CheckoutProps = {
  version?: string; // if reset is true, the version is undefined
  ids?: BitId[];
  latestVersion?: boolean;
  promptMergeOptions: boolean;
  mergeStrategy: MergeStrategy | null | undefined;
  verbose: boolean;
  skipNpmInstall: boolean;
  reset: boolean; // remove local changes. if set, the version is undefined.
  all: boolean; // checkout all ids
  ignoreDist: boolean;
};
type ComponentStatus = {
  componentFromFS?: ConsumerComponent;
  componentFromModel?: Version;
  id: BitId;
  failureMessage?: string;
  mergeResults?: MergeResultsThreeWay | null | undefined;
};

export default (async function checkoutVersion(
  consumer: Consumer,
  checkoutProps: CheckoutProps
): Promise<ApplyVersionResults> {
  const { version, ids, promptMergeOptions } = checkoutProps;
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  const { components } = await consumer.loadComponents(ids);
  const allComponentsStatus: ComponentStatus[] = await getAllComponentsStatus();
  const componentWithConflict = allComponentsStatus.find(
    component => component.mergeResults && component.mergeResults.hasConflicts
  );
  if (componentWithConflict) {
    if (!promptMergeOptions && !checkoutProps.mergeStrategy) {
      throw new GeneralError(
        `automatic merge has failed for component ${componentWithConflict.id.toStringWithoutVersion()}.\nplease use "--manual" to manually merge changes or use "--theirs / --ours" to choose one of the conflicted versions`
      );
    }
    if (!checkoutProps.mergeStrategy) checkoutProps.mergeStrategy = await getMergeStrategyInteractive();
  }
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  const failedComponents: FailedComponents[] = allComponentsStatus
    .filter(componentStatus => componentStatus.failureMessage) // $FlowFixMe componentStatus.failureMessage is set
    .map(componentStatus => ({ id: componentStatus.id, failureMessage: componentStatus.failureMessage }));

  const succeededComponents = allComponentsStatus.filter(componentStatus => !componentStatus.failureMessage);
  // do not use Promise.all for applyVersion. otherwise, it'll write all components in parallel,
  // which can be an issue when some components are also dependencies of others
  const componentsResults = await pMapSeries(succeededComponents, ({ id, componentFromFS, mergeResults }) => {
    return applyVersion(consumer, id, componentFromFS, mergeResults, checkoutProps);
  });

  return { components: componentsResults, version, failedComponents };

  async function getAllComponentsStatus(): Promise<ComponentStatus[]> {
    const tmp = new Tmp(consumer.scope);
    try {
      const componentsStatus = await Promise.all(
        components.map(component => getComponentStatus(consumer, component, checkoutProps))
      );
      await tmp.clear();
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      return componentsStatus;
    } catch (err) {
      await tmp.clear();
      throw err;
    }
  }
});

async function getComponentStatus(
  consumer: Consumer,
  component: ConsumerComponent,
  checkoutProps: CheckoutProps
): Promise<ComponentStatus> {
  const { version, latestVersion, reset } = checkoutProps;
  const componentModel = await consumer.scope.getModelComponentIfExist(component.id);
  const componentStatus: ComponentStatus = { id: component.id };
  const returnFailure = (msg: string) => {
    componentStatus.failureMessage = msg;
    return componentStatus;
  };
  if (!componentModel) {
    return returnFailure(`component ${component.id.toString()} doesn't have any version yet`);
  }
  const getNewVersion = (): string => {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    if (reset) return component.id.version;
    // $FlowFixMe if !reset the version is defined
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return latestVersion ? componentModel.latest() : version;
  };
  const newVersion = getNewVersion();
  if (version && !latestVersion && !componentModel.hasVersion(version)) {
    return returnFailure(`component ${component.id.toStringWithoutVersion()} doesn't have version ${version}`);
  }
  const existingBitMapId = consumer.bitMap.getBitId(component.id, { ignoreVersion: true });
  const currentlyUsedVersion = existingBitMapId.version;
  if (version && currentlyUsedVersion === version) {
    // it won't be relevant for 'reset' as it doesn't have a version
    return returnFailure(`component ${component.id.toStringWithoutVersion()} is already at version ${version}`);
  }
  if (latestVersion && currentlyUsedVersion === newVersion) {
    return returnFailure(
      `component ${component.id.toStringWithoutVersion()} is already at the latest version, which is ${newVersion}`
    );
  }
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  const baseComponent: Version = await componentModel.loadVersion(currentlyUsedVersion, consumer.scope.objects);
  const isModified = await consumer.isComponentModified(baseComponent, component);
  if (!isModified && reset) {
    return returnFailure(`component ${component.id.toStringWithoutVersion()} is not modified`);
  }
  let mergeResults: MergeResultsThreeWay | null | undefined;
  if (isModified && version) {
    const currentComponent: Version = await componentModel.loadVersion(newVersion, consumer.scope.objects);
    mergeResults = await threeWayMerge({
      consumer,
      otherComponent: component,
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      otherVersion: currentlyUsedVersion,
      currentComponent,
      currentVersion: newVersion,
      baseComponent
    });
  }
  const versionRef = componentModel.versions[newVersion];
  const componentVersion = await consumer.scope.getObject(versionRef.hash);
  const newId = component.id.changeVersion(newVersion);
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  return { componentFromFS: component, componentFromModel: componentVersion, id: newId, mergeResults };
}

/**
 * 1) when the files are modified with conflicts and the strategy is "ours", leave the FS as is
 * and update only bitmap id version. (not the componentMap object).
 *
 * 2) when the files are modified with conflicts and the strategy is "theirs", write the component
 * according to id.version.
 *
 * 3) when files are modified with no conflict or files are modified with conflicts and the
 * strategy is manual, load the component according to id.version and update component.files.
 * applyModifiedVersion() docs explains what files are updated/added.
 *
 * 4) when --reset flag is used, write the component according to the bitmap version
 *
 * Side note:
 * Deleted file => if files are in used version but not in the modified one, no need to delete it. (similar to git).
 * Added file => if files are not in used version but in the modified one, they'll be under mergeResults.addFiles
 */
async function applyVersion(
  consumer: Consumer,
  id: BitId,
  componentFromFS: ConsumerComponent,
  mergeResults: MergeResultsThreeWay | null | undefined,
  checkoutProps: CheckoutProps
): Promise<ApplyVersionResult> {
  const { mergeStrategy, verbose, skipNpmInstall, ignoreDist } = checkoutProps;
  const filesStatus = {};
  if (mergeResults && mergeResults.hasConflicts && mergeStrategy === MergeOptions.ours) {
    componentFromFS.files.forEach(file => {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.unchanged;
    });
    consumer.bitMap.updateComponentId(id);
    return { id, filesStatus };
  }
  const componentWithDependencies = await consumer.loadComponentWithDependenciesFromModel(id);
  const componentMap = componentFromFS.componentMap;
  if (!componentMap) throw new GeneralError('applyVersion: componentMap was not found');
  if (componentMap.origin === COMPONENT_ORIGINS.AUTHORED && !id.scope) {
    componentWithDependencies.dependencies = [];
    componentWithDependencies.devDependencies = [];
    componentWithDependencies.compilerDependencies = [];
    componentWithDependencies.testerDependencies = [];
  }
  const rootDir = componentMap.rootDir;
  const shouldWritePackageJson = async (): Promise<boolean> => {
    if (!rootDir) return false;
    const packageJsonPath = path.join(consumer.getPath(), rootDir, 'package.json');
    return fs.exists(packageJsonPath);
  };
  const shouldInstallNpmPackages = (): boolean => {
    if (componentMap.origin === COMPONENT_ORIGINS.AUTHORED) return false;
    return !skipNpmInstall;
  };
  const writePackageJson = await shouldWritePackageJson();

  const files = componentWithDependencies.component.files;
  files.forEach(file => {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.updated;
  });

  let modifiedStatus = {};
  if (mergeResults) {
    // update files according to the merge results
    modifiedStatus = applyModifiedVersion(
      files,
      mergeResults,
      mergeStrategy,
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      componentWithDependencies.component.originallySharedDir
    );
  }
  const shouldDependenciesSaveAsComponents = await consumer.shouldDependenciesSavedAsComponents([id]);
  componentWithDependencies.component.dependenciesSavedAsComponents =
    shouldDependenciesSaveAsComponents[0].saveDependenciesAsComponents;

  const manyComponentsWriter = new ManyComponentsWriter({
    consumer,
    componentsWithDependencies: [componentWithDependencies],
    installNpmPackages: shouldInstallNpmPackages(),
    override: true,
    writeConfig: Boolean(componentMap.configDir), // write bit.json and config files only if it was there before
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    configDir: componentMap.configDir,
    verbose,
    writeDists: !ignoreDist,
    writePackageJson
  });
  await manyComponentsWriter.writeAll();

  return { id, filesStatus: Object.assign(filesStatus, modifiedStatus) };
}

/**
 * relevant only when
 * 1) there is no conflict => add files from mergeResults: addFiles, overrideFiles and modifiedFiles.output.
 * 2) there is conflict and mergeStrategy is manual => add files from mergeResults: addFiles, overrideFiles and modifiedFiles.conflict.
 *
 * this function only updates the files content, it doesn't write the files
 */
export function applyModifiedVersion(
  componentFiles: SourceFile[],
  mergeResults: MergeResultsThreeWay,
  mergeStrategy: MergeStrategy | null | undefined,
  sharedDir?: string
): Record<string, any> {
  const filesStatus = {};
  if (mergeResults.hasConflicts && mergeStrategy !== MergeOptions.manual) return filesStatus;
  mergeResults.modifiedFiles.forEach(file => {
    const filePath: PathOsBased = path.normalize(file.filePath);
    const pathWithSharedDir = (p: string) => (sharedDir ? path.join(sharedDir, p) : p);
    const foundFile = componentFiles.find(componentFile => pathWithSharedDir(componentFile.relative) === filePath);
    if (!foundFile) throw new GeneralError(`file ${filePath} not found`);
    if (file.conflict) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      foundFile.contents = Buffer.from(file.conflict);
      filesStatus[file.filePath] = FileStatus.manual;
    } else if (file.output) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      foundFile.contents = Buffer.from(file.output);
      filesStatus[file.filePath] = FileStatus.merged;
    } else {
      throw new GeneralError('file does not have output nor conflict');
    }
  });
  mergeResults.addFiles.forEach(file => {
    componentFiles.push(file.fsFile);
    filesStatus[file.filePath] = FileStatus.added;
  });
  mergeResults.overrideFiles.forEach(file => {
    const filePath: PathOsBased = path.normalize(file.filePath);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const foundFile = componentFiles.find(componentFile => componentFile.relative === filePath);
    if (!foundFile) throw new GeneralError(`file ${filePath} not found`);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    foundFile.contents = file.fsFile.contents;
    filesStatus[file.filePath] = FileStatus.overridden;
  });

  return filesStatus;
}
