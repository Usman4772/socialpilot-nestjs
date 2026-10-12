import { IsNotEmpty, IsString } from 'class-validator';

export class ExchangeGoogleDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}
