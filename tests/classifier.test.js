const { extractTargets, extractTime, mergeAndCleanTargets } = require('../src/messaging/classifier');

describe('Classifier Utility Functions', () => {
    describe('extractTargets', () => {
        it('should correctly extract targets and map them to their base names', () => {
            expect(extractTargets('התרעה באזור גוש דן')).toBe('מרכז');
        });

        it('should handle parenthesis extraction correctly', () => {
            expect(extractTargets('התרעה באזור נתניה (מזרח)')).toBe('שרון (מזרח)');
        });

        it('should ignore "דרום לבנון" as it is blacklisted in extraction', () => {
            expect(extractTargets('תקיפה בדרום לבנון')).toBe('');
        });
    });

    describe('mergeAndCleanTargets', () => {
        it('should merge targets without duplication', () => {
            expect(mergeAndCleanTargets('מרכז, שפלה', 'מרכז')).toBe('מרכז, שפלה');
        });

        it('should sort the merged targets', () => {
            expect(mergeAndCleanTargets('שרון', 'חיפה')).toBe('חיפה, שרון');
        });
    });

    describe('extractTime', () => {
        it('should extract absolute times correctly', () => {
            expect(extractTime('השיגור יגיע בשעה 22:30')).toBe('22:30');
        });
    });
});
