export type JwtAuthUser = {
  userId: string;
  username: string;
  email: string;
};

export type AuthUserResponse = {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  pictureUrl: string | null;
};
