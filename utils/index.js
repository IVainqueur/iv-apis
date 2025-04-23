export const parseJson = (jsonString) => {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    return {};
  }
};
