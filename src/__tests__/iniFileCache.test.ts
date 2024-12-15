import * as fs from 'fs';
import * as path from 'path';
import IniFileCache from '../iniFileCache';

jest.mock('fs');
jest.mock('path');
jest.mock('@mdaemon/emitter/dist/emitter.mjs');

describe('IniFileCache', () => {
  let iniFileCache: IniFileCache;
  const mockCachePath = '/mock/cache/path';
  const mockFileName = 'test.ini';

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    iniFileCache = new IniFileCache(mockCachePath, mockFileName);
  });

  test('constructor creates cache directory if it doesn\'t exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
    new IniFileCache(mockCachePath, mockFileName);
    expect(fs.mkdirSync).toHaveBeenCalledWith(mockCachePath, { recursive: true });
  });

  test('constructor creates file if it doesn\'t exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValueOnce(true).mockReturnValueOnce(false);
    new IniFileCache(mockCachePath, mockFileName);
    expect(fs.writeFileSync).toHaveBeenCalledWith(path.join(mockCachePath, mockFileName), '');
  });

  test('parseContents correctly parses ini content', () => {
    const mockContent = `
      [Section1]
      key1=value1
      key2=value2

      [Section2]
      key3=value3
    `;
    iniFileCache.parseContents(mockContent);
    expect(iniFileCache['settings']).toEqual([
      { name: 'Section1', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] },
      { name: 'Section2', settings: [{ key: 'key3', value: 'value3' }] }
    ]);
  });

  test('getSetting returns correct value', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'testKey', value: 'testValue' }] }
    ];
    expect(iniFileCache.getSetting('TestSection', 'testKey')).toBe('testValue');
  });

  test('getSetting returns default value when key not found', () => {
    expect(iniFileCache.getSetting('NonexistentSection', 'nonexistentKey', 'defaultValue')).toBe('defaultValue');
  });

  test('setSetting adds new section and key', () => {
    iniFileCache.setSetting('NewSection', 'newKey', 'newValue');
    expect(iniFileCache['settings']).toContainEqual({
      name: 'NewSection',
      settings: [{ key: 'newKey', value: 'newValue' }]
    });
  });

  test('save writes settings to file', async () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [{ key: 'key1', value: 'value1' }] }
    ];
    await iniFileCache.save();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(mockCachePath, mockFileName),
      '[Section1]\nkey1=value1\n\n', {"flush": true}
    );
  });

  test('watch calls cacheFileSettings on file change', () => {
    const mockWatch = jest.fn().mockImplementation((file, callback) => {
      callback('change', 'test.ini');
    });
    jest.spyOn(fs, 'watch').mockImplementation(mockWatch);
    
    const spyCacheFileSettings = jest.spyOn(iniFileCache, 'cacheFileSettings');
    iniFileCache.watch();
    
    expect(spyCacheFileSettings).toHaveBeenCalled();
  });

  test('getSections returns all section names', () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [] },
      { name: 'Section2', settings: [] }
    ];
    expect(iniFileCache.getSections()).toEqual(['Section1', 'Section2']);
  });

  test('getKeys returns all keys in a section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] }
    ];
    expect(iniFileCache.getKeys('TestSection')).toEqual(['key1', 'key2']);
  });

  test('hasSection returns true if section exists', () => {
    iniFileCache['settings'] = [{ name: 'TestSection', settings: [] }];
    expect(iniFileCache.hasSection('TestSection')).toBe(true);
    expect(iniFileCache.hasSection('NonexistentSection')).toBe(false);
  });

  test('hasKey returns true if key exists in section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'testKey', value: 'testValue' }] }
    ];
    expect(iniFileCache.hasKey('TestSection', 'testKey')).toBe(true);
    expect(iniFileCache.hasKey('TestSection', 'nonexistentKey')).toBe(false);
  });

  test('removeSection removes the specified section', () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [] },
      { name: 'Section2', settings: [] }
    ];
    iniFileCache.removeSection('Section1');
    expect(iniFileCache['settings']).toEqual([{ name: 'Section2', settings: [] }]);
  });

  test('removeKey removes the specified key from a section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] }
    ];
    iniFileCache.removeKey('TestSection', 'key1');
    expect(iniFileCache['settings']).toEqual([
      { name: 'TestSection', settings: [{ key: 'key2', value: 'value2' }] }
    ]);
  });

  test('reload calls cacheFileSettings and emits reload event', async () => {
    const spyCacheFileSettings = jest.spyOn(iniFileCache, 'cacheFileSettings');
    const spyEmit = jest.spyOn(iniFileCache.listener, 'emit');
    await iniFileCache.reload();
    expect(spyCacheFileSettings).toHaveBeenCalled();
    expect(spyEmit).toHaveBeenCalledWith('reload', iniFileCache['file']);
  });

  test('unwatch stops watching the file', () => {
    const mockUnwatchFile = jest.spyOn(fs, 'unwatchFile').mockImplementation(() => {});
    iniFileCache['watching'] = {}; // Mock watching object
    iniFileCache.unwatch();
    expect(mockUnwatchFile).toHaveBeenCalledWith(iniFileCache['file']);
    expect(iniFileCache['watching']).toBeNull();
  });
});